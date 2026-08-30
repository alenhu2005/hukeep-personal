import { describe, expect, it } from 'vitest';
import {
  mergeLedgerStates,
  reconcileLedgerFromSheet,
  updatePendingSheetChanges,
} from '../src/domain/ledger-sync.js';

function state(transactions = [], options = {}) {
  return {
    schemaVersion: 1,
    accounts: options.accounts ?? [],
    transactions,
    budgets: options.budgets ?? [],
    preferences: options.preferences ?? { theme: 'system' },
  };
}

describe('Sheet 雙向更新合併', () => {
  it('Sheet 已刪除的既有交易會從網頁移除', () => {
    const local = state([
      { id: 'kept', updatedAt: '2026-08-29T06:00:00.000Z' },
      { id: 'deleted-in-sheet', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'kept', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    expect(reconcileLedgerFromSheet(local, remote).transactions).toEqual(remote.transactions);
  });

  it('只把仍待上傳的本機新增或修改覆蓋回 Sheet 最新資料', () => {
    const local = state([
      { id: 'local-pending', name: '我剛修改', updatedAt: '2026-08-29T06:02:00.000Z' },
      { id: 'local-new', name: '尚未上傳的新資料', updatedAt: '2026-08-29T06:02:00.000Z' },
      { id: 'stale-local', name: '舊本機資料', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'local-pending', name: 'Sheet 舊資料', updatedAt: '2026-08-29T06:01:00.000Z' },
      { id: 'remote-only', name: 'Sheet 新資料', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = reconcileLedgerFromSheet(local, remote, {
      upserts: ['local-pending', 'local-new'],
      deletes: [],
    });
    expect(result.transactions).toEqual([
      local.transactions[0],
      remote.transactions[1],
      local.transactions[1],
    ]);
  });

  it('本機待上傳刪除不會被 Sheet 背景讀取復活', () => {
    const remote = state([
      { id: 'pending-delete', updatedAt: '2026-08-29T06:01:00.000Z' },
      { id: 'kept', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = reconcileLedgerFromSheet(state([]), remote, {
      upserts: [],
      deletes: ['pending-delete'],
    });
    expect(result.transactions.map(transaction => transaction.id)).toEqual(['kept']);
  });

  it('從前後狀態建立不可變的待同步新增與刪除清單', () => {
    const before = state([
      { id: 'edited', name: '舊名稱' },
      { id: 'deleted', name: '要刪除' },
    ]);
    const after = state([
      { id: 'edited', name: '新名稱' },
      { id: 'added', name: '新增' },
    ]);
    const previous = { upserts: ['restored'], deletes: ['added'] };

    expect(updatePendingSheetChanges(previous, before, after)).toEqual({
      upserts: ['restored', 'edited', 'added'],
      deletes: ['deleted'],
    });
    expect(previous).toEqual({ upserts: ['restored'], deletes: ['added'] });
  });

  it('以較新的後台 AI 審查結果取代本機待審草稿', () => {
    const local = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:00:00.000Z', aiStatus: 'pending' },
    ]);
    const remote = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:01:00.000Z', aiStatus: 'reviewed' },
    ]);

    expect(mergeLedgerStates(local, remote).transactions).toEqual(remote.transactions);
  });

  it('保留時間較新的人工修改，並合併兩邊獨有的記錄', () => {
    const local = state([
      {
        id: 'voice:1',
        updatedAt: '2026-08-29T06:02:00.000Z',
        userEditedAt: '2026-08-29T06:02:00.000Z',
        name: '我改的',
      },
      { id: 'local-only', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:01:00.000Z', name: 'AI 改的' },
      { id: 'remote-only', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = mergeLedgerStates(local, remote);
    expect(result.transactions.map(transaction => transaction.id)).toEqual([
      'voice:1',
      'local-only',
      'remote-only',
    ]);
    expect(result.transactions[0].name).toBe('我改的');
  });

  it('同步 Sheet 的帳戶與預算，但保留本機偏好設定', () => {
    const local = state([], {
      accounts: [{ id: 'cash', openingBalance: 1 }],
      budgets: [{ category: '飲食', limit: 1 }],
      preferences: { theme: 'dark', proxyEndpoint: 'https://example.com' },
    });
    const remote = state([], {
      accounts: [{ id: 'cash', openingBalance: 5000 }],
      budgets: [{ category: '飲食', limit: 6000 }],
    });

    expect(mergeLedgerStates(local, remote)).toMatchObject({
      accounts: remote.accounts,
      budgets: remote.budgets,
      preferences: local.preferences,
    });
  });

  it('Sheet 空帳戶或缺少預算時不清除本機設定', () => {
    const local = state([], {
      accounts: [{ id: 'cash', openingBalance: 100 }],
      budgets: [{ category: '交通', limit: 2000 }],
    });
    const result = mergeLedgerStates(local, {
      schemaVersion: 1,
      accounts: [],
      transactions: [],
    });

    expect(result.accounts).toEqual(local.accounts);
    expect(result.budgets).toEqual(local.budgets);
  });

  it('容忍空狀態與無效時間，同時保留本機版本', () => {
    expect(mergeLedgerStates(null, null)).toEqual({
      schemaVersion: 1,
      accounts: [],
      transactions: [],
      budgets: [],
      preferences: {},
    });

    const local = state([{ id: 'same', updatedAt: 'not-a-date', name: '本機' }]);
    const remote = state([{ id: 'same', updatedAt: '', name: 'Sheet' }]);
    expect(mergeLedgerStates(local, remote).transactions[0].name).toBe('本機');
  });
});
