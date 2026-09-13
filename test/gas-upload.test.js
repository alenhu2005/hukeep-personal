import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../gas/invoice-proxy.gs', import.meta.url), 'utf8');

function sheet() {
  const rows = [];
  const writes = [];
  return {
    rows, writes,
    getMaxColumns: () => 30,
    getMaxRows: () => 1000,
    clearContents() { rows.splice(0, rows.length); },
    getLastRow: () => rows.length,
    autoResizeColumns() {},
    setFrozenRows() {},
    appendRow(row) { rows.push(row); },
    getRange(start, column, count = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: count }, (_, i) =>
          Array.from({ length: width }, (_, j) => rows[start - 1 + i]?.[column - 1 + j] ?? '')),
        setValues(values) {
          writes.push({ start, count, width });
          values.forEach((row, i) => { rows[start - 1 + i] = row.slice(); });
        },
      };
    },
  };
}

function harness() {
  const sheets = new Map();
  const lock = { tryLock: vi.fn(() => true), waitLock: vi.fn(), releaseLock: vi.fn() };
  const context = {
    console,
    Utilities: { getUuid: () => 'unique-id', formatDate: () => '2026-09-13' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'sheet-id' }) },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: {
      flush: vi.fn(),
      openById: () => ({
        getSheetByName: (name) => sheets.get(name),
        insertSheet(name) { const value = sheet(); sheets.set(name, value); return value; },
      }),
    },
    ScriptApp: { getProjectTriggers: () => [{ getHandlerFunction: () => 'processPendingSpokenEntries' }] },
  };
  runInNewContext(source, context);
  return { context, sheets, lock };
}

describe('GAS spoken upload batching', () => {
  it('writes four distinct queue and transaction rows with one batch per sheet', () => {
    const { context, sheets, lock } = harness();
    const result = context.enqueueSpokenEntry_({ transcript: '鍋貼100濃湯45豆漿20麵60都用Line',
      drafts: [100, 45, 20, 60].map((amount) => ({ name: `品項${amount}`, amount, account: 'line' })) });
    expect(result.transactions).toHaveLength(4);
    expect(new Set(result.transactions.map((row) => row.id)).size).toBe(4);
    for (const name of ['小帳_語音佇列', '小帳_交易']) {
      expect(sheets.get(name).rows).toHaveLength(5);
      expect(sheets.get(name).writes.filter((write) => write.start > 1)).toEqual([
        expect.objectContaining({ start: 2, count: 4 }),
      ]);
    }
    expect(sheets.get('小帳_交易').rows.slice(1).map((row) => row[3])).toEqual([100, 45, 20, 60]);
    expect(lock.releaseLock).toHaveBeenCalledOnce();
  });

  it('keeps unrecognized amounts in the queue without creating zero-value transactions', () => {
    const { context, sheets, lock } = harness();
    const result = context.enqueueSpokenEntry_({ transcript: '午餐金額忘了' });
    expect(result.transaction).toBeNull();
    expect(result.transactions).toHaveLength(0);
    expect(sheets.get('小帳_語音佇列').rows).toHaveLength(2);
    expect(sheets.get('小帳_交易')?.rows.length ?? 0).toBeLessThanOrEqual(1);
    expect(lock.releaseLock).toHaveBeenCalledOnce();
  });

  it('preserves existing transactions and expands a full sheet for the new batch', () => {
    const { context, sheets } = harness();
    const existing = sheet();
    existing.rows.push(Array.from(context.LEDGER_TRANSACTION_HEADERS));
    const original = Array(27).fill('');
    original[0] = 'manual:existing';
    original[1] = 'income';
    original[2] = '家教';
    original[3] = 1500;
    existing.rows.push(original);
    existing.getMaxRows = () => 2;
    existing.insertRowsAfter = vi.fn();
    sheets.set('小帳_交易', existing);
    context.enqueueSpokenEntry_({ transcript: '午餐100飲料20', drafts: [{ amount: 100 }, { amount: 20 }] });
    expect(existing.rows[1]).toEqual(original);
    expect(existing.insertRowsAfter).toHaveBeenCalledWith(2, 2);
    expect(existing.writes).toEqual([{ start: 3, count: 2, width: 27 }]);
  });

  it('retains queue-only items while batching only positive drafts into transactions', () => {
    const { context, sheets } = harness();
    const result = context.enqueueSpokenEntry_({ transcript: '午餐100飲料忘記金額',
      drafts: [{ amount: 100 }, { amount: 0 }] });
    expect(result.queueIds).toHaveLength(2);
    expect(result.transactions).toHaveLength(1);
    expect(sheets.get('小帳_語音佇列').rows).toHaveLength(3);
    expect(sheets.get('小帳_交易').rows).toHaveLength(2);
  });

  it('returns a bounded busy error before writing when the lock is unavailable', () => {
    const { context, sheets, lock } = harness();
    lock.tryLock.mockReturnValue(false);
    expect(() => context.enqueueSpokenEntry_({ transcript: '午餐100' })).toThrow('忙碌');
    expect(lock.tryLock).toHaveBeenCalledWith(5000);
    expect(sheets.size).toBe(0);
    expect(lock.releaseLock).not.toHaveBeenCalled();
  });

  it('replaying the same client IDs returns existing rows without appending duplicates', () => {
    const { context, sheets } = harness();
    const body = {
      transcript: '午餐100飲料20',
      groupId: 'voice-group-1',
      drafts: [
        { clientId: 'voice-group-1:1', name: '午餐', amount: 100, account: 'cash' },
        { clientId: 'voice-group-1:2', name: '飲料', amount: 20, account: 'cash' },
      ],
    };
    const first = context.enqueueSpokenEntry_(body);
    const queueRowsAfterFirst = sheets.get('小帳_語音佇列').rows.length;
    const transactionRowsAfterFirst = sheets.get('小帳_交易').rows.length;
    const second = context.enqueueSpokenEntry_(body);
    expect(second.transactions.map(row => row.id)).toEqual(first.transactions.map(row => row.id));
    expect(sheets.get('小帳_語音佇列').rows.length).toBe(queueRowsAfterFirst);
    expect(sheets.get('小帳_交易').rows.length).toBe(transactionRowsAfterFirst);
  });

  it('uploads an offline voice transaction into the AI queue once the journal reconnects', () => {
    const { context, sheets } = harness();
    const changes = {
      accounts: [], accountDeletes: [],
      transactions: [{
        id: 'voice:offline-1', type: 'expense', name: '早餐', amount: 80,
        category: '飲食', subcategory: '早餐', account: 'cash', toAccount: '',
        date: '2026-09-13', source: 'voice', sourceId: 'offline-1',
        rawTranscript: '現金買早餐80', aiStatus: 'pending',
        createdAt: '2026-09-13T01:00:00.000Z', updatedAt: '2026-09-13T01:00:00.000Z',
      }],
      transactionDeletes: [], budgets: [], budgetDeletes: [],
    };
    context.syncLedgerChanges_(changes);
    context.syncLedgerChanges_(changes);
    expect(sheets.get('小帳_交易').rows).toHaveLength(2);
    expect(sheets.get('小帳_語音佇列').rows).toHaveLength(2);
    expect(sheets.get('小帳_語音佇列').rows[1][4]).toBe('voice:offline-1');
  });

  it('releases an acquired lock when a Sheet write fails', () => {
    const { context, lock } = harness();
    context.SpreadsheetApp.openById = () => { throw new Error('Sheet unavailable'); };
    expect(() => context.enqueueSpokenEntry_({ transcript: '午餐100' })).toThrow('Sheet unavailable');
    expect(lock.releaseLock).toHaveBeenCalledOnce();
  });
});
