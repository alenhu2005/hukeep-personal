import { describe, expect, it } from 'vitest';
import { reconciliationAdjustmentId, reconciliationAdjustmentNote, reconciliationAdjustmentStatus, resolveAlignedReconciliations, transactionsAtReconciliation } from '../src/domain/reconciliation.js';
import { calculateAccountBalances } from '../src/domain/insights.js';
import { normalizeLedgerState } from '../src/storage/ledger-repository.js';
import { reconcileLedgerFromSheet, updatePendingSheetChanges } from '../src/domain/ledger-sync.js';
import { projectLedgerChangesForSheet } from '../src/services/import-proxy.js';

describe('對帳調整', () => {
  const item = { id: 'statement', accountId: 'cash', actualBalance: 70, date: '2026-09-10' };
  const state = { accounts: [{ id: 'cash', openingBalance: 80 }], transactions: [] };
  const correction = { id: 'reconcile-adjust:statement', type: 'expense', source: 'manual',
    category: '帳務調整', amount: 10, account: 'cash', date: item.date };

  it('歷史交易變動後允許重新計算同一筆調整，不把未來交易算入', () => {
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction] }, item))
      .toMatchObject({ difference: -10, corrected: true });
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction,
      { type: 'income', amount: 20, account: 'cash', date: '2026-09-01' },
      { type: 'income', amount: 100, account: 'cash', date: '2026-09-11' },
    ] }, item)).toMatchObject({ difference: -30, corrected: false, adjustment: correction });
  });

  it.each([
    [{ type: 'expense', amount: 20, account: 'cash' }, 60],
    [{ type: 'income', amount: 20, account: 'cash' }, 100],
    [{ type: 'transfer', amount: 20, fee: 2, feeMode: 'included', account: 'cash', toAccount: 'line' }, 60],
    [{ type: 'transfer', amount: 20, fee: 2, feeMode: 'additional', account: 'line', toAccount: 'cash' }, 100],
  ])('同日對帳後的新交易只變動目前餘額，不產生對帳差額 %j', (entry, balance) => {
    const checkpoint = { ...item, actualBalance: 80, createdAt: '2026-09-10T04:00:00.000Z' };
    const next = { ...state, transactions: [{ ...entry, id: 'after', date: item.date,
      createdAt: '2026-09-10T04:01:00.000Z' }] };
    expect(reconciliationAdjustmentStatus(next, checkpoint)).toMatchObject({ estimatedBalance: 80, difference: 0 });
    expect(calculateAccountBalances(next.accounts, next.transactions)[0].balance).toBe(balance);
  });

  it('同日新增記帳不使已套用的對帳調整變成待重新調整，但修改原交易仍能檢查', () => {
    const checkpoint = { ...item, createdAt: '2026-09-10T04:00:00.000Z' };
    const before = { id: 'before', type: 'expense', amount: 5, account: 'cash', date: item.date,
      createdAt: '2026-09-10T03:00:00.000Z' };
    const adjustment = { ...correction, amount: 5, createdAt: '2026-09-10T04:01:00.000Z' };
    const after = { ...before, id: 'after', amount: 20, createdAt: '2026-09-10T04:02:00.000Z' };
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [before, adjustment, after] }, checkpoint))
      .toMatchObject({ estimatedBalance: 75, difference: -5, corrected: true });
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [{ ...before, amount: 8 }, adjustment, after] }, checkpoint))
      .toMatchObject({ estimatedBalance: 72, difference: -2, corrected: false });
  });

  it('以實際時間比較時區，保留舊資料的日期界線與回溯交易檢查', () => {
    const checkpoint = { ...item, createdAt: '2026-09-10T04:00:00.000Z' };
    const transactions = [
      { id: 'before', date: item.date, createdAt: '2026-09-10T11:59:00+08:00' },
      { id: 'at', date: item.date, createdAt: '2026-09-10T12:00:00+08:00' },
      { id: 'after', date: item.date, createdAt: '2026-09-10T12:01:00+08:00' },
      { id: 'legacy', date: item.date },
      { id: 'invalid-time', date: item.date, createdAt: 'invalid' },
      { id: 'backdated', date: '2026-09-09', createdAt: '2026-09-11T04:00:00.000Z' },
      { id: 'future', date: '2026-09-11', createdAt: '2026-09-09T04:00:00.000Z' },
    ];
    expect(transactionsAtReconciliation(transactions, checkpoint).map(transaction => transaction.id))
      .toEqual(['before', 'at', 'legacy', 'invalid-time', 'backdated']);
    expect(transactionsAtReconciliation(transactions, item).map(transaction => transaction.id))
      .toEqual(['before', 'at', 'after', 'legacy', 'invalid-time', 'backdated']);
  });

  it('長 ID 使用穩定且不被截斷的 SHA-256 ID，完整原 ID 留在關聯備註', async () => {
    const longId = 'a'.repeat(80);
    const txId = await reconciliationAdjustmentId(longId);
    expect(txId.length).toBeLessThanOrEqual(80);
    expect(await reconciliationAdjustmentId(longId)).toBe(txId);
    expect(await reconciliationAdjustmentId(`${'a'.repeat(79)}b`)).not.toBe(txId);
    const reconciliation = { ...item, id: longId };
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [{ ...correction,
      id: txId, note: reconciliationAdjustmentNote(reconciliation),
    }] }, reconciliation)).toMatchObject({ corrected: true });
  });

  it('舊版重複調整不會被誤認為已正確調整', () => {
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction, correction] }, item))
      .toMatchObject({ estimatedBalance: 80, difference: -10, corrected: false });
  });

  it.each([
    [70, { type: 'expense', amount: 10, account: 'cash' }],
    [90, { type: 'income', amount: 10, account: 'cash' }],
    [60, { type: 'transfer', amount: 20, fee: 2, feeMode: 'included', account: 'cash', toAccount: 'line' }],
    [58, { type: 'transfer', amount: 20, fee: 2, feeMode: 'additional', account: 'cash', toAccount: 'line' }],
    [98, { type: 'transfer', amount: 20, fee: 2, feeMode: 'included', account: 'line', toAccount: 'cash' }],
  ])('補記使餘額對齊 %s 時自動解除差額，只連結補記而不新增調整 %j', (actualBalance, entry) => {
    const checkpoint = { ...item, actualBalance, createdAt: '2026-09-10T04:00:00.000Z' };
    const before = { ...state, accounts: [...state.accounts, { id: 'line', openingBalance: 0 }],
      featureSettings: { reconciliations: [checkpoint] }, transactions: [{ ...entry, id: 'supplement',
        date: checkpoint.date, createdAt: '2026-09-10T04:01:00.000Z' }] };
    const resolved = resolveAlignedReconciliations(before);
    expect(resolved.featureSettings.reconciliations[0]).toMatchObject({ id: item.id, includedTransactionIds: ['supplement'] });
    expect(reconciliationAdjustmentStatus(resolved, resolved.featureSettings.reconciliations[0])).toMatchObject({ difference: 0 });
    expect(resolved.transactions).toBe(before.transactions);
    expect(resolveAlignedReconciliations(resolved)).toBe(resolved);
  });

  it('補記未對齊或投資市值不同時不自動宣告相符，只處理每個帳戶最新的對帳', () => {
    const checkpoint = { ...item, createdAt: '2026-09-10T04:00:00.000Z' };
    const before = { ...state, featureSettings: { reconciliations: [checkpoint] }, transactions: [{
      id: 'partial', type: 'expense', amount: 5, account: 'cash', date: item.date, createdAt: '2026-09-10T04:01:00.000Z',
    }] };
    expect(resolveAlignedReconciliations(before)).toBe(before);
    const superseded = { ...before, transactions: [{ ...before.transactions[0], amount: 10 }],
      featureSettings: { reconciliations: [checkpoint, { ...checkpoint, id: 'latest', date: '2026-09-11', actualBalance: 80 }] } };
    expect(resolveAlignedReconciliations(superseded)).toBe(superseded);
    const investment = { accounts: [{ id: 'investment', openingBalance: 80 }],
      featureSettings: { reconciliations: [{ ...checkpoint, accountId: 'investment' }] },
      transactions: [{ ...before.transactions[0], amount: 10, account: 'investment' }] };
    expect(resolveAlignedReconciliations(investment)).toBe(investment);
  });

  it('補齊後的新支出不重開舊差額，但修改或刪除已連結的補記仍能檢查', () => {
    const checkpoint = { ...item, createdAt: '2026-09-10T04:00:00.000Z' };
    const supplement = { id: 'supplement', type: 'expense', amount: 10, account: 'cash', date: item.date,
      createdAt: '2026-09-10T04:01:00.000Z' };
    const resolved = resolveAlignedReconciliations({ ...state,
      featureSettings: { reconciliations: [checkpoint] }, transactions: [supplement] });
    const after = { ...resolved, transactions: [...resolved.transactions,
      { ...supplement, id: 'new-expense', amount: 20, createdAt: '2026-09-10T04:02:00.000Z' }] };
    const linked = resolved.featureSettings.reconciliations[0];
    expect(resolveAlignedReconciliations(after)).toBe(after);
    expect(reconciliationAdjustmentStatus(after, linked)).toMatchObject({ estimatedBalance: 70, difference: 0 });
    expect(calculateAccountBalances(after.accounts, after.transactions)[0].balance).toBe(50);
    expect(reconciliationAdjustmentStatus({ ...after, transactions: [{ ...supplement, amount: 15 }] }, linked)).toMatchObject({ difference: 5 });
    expect(reconciliationAdjustmentStatus({ ...after, transactions: [] }, linked)).toMatchObject({ difference: -10 });
  });

  it('補記連結可重整、備份與跨裝置同步，只佇列原對帳 ID 的更新', () => {
    const checkpoint = { ...item, createdAt: '2026-09-10T04:00:00.000Z' };
    const before = normalizeLedgerState({ ...state, accounts: [{ ...state.accounts[0], name: '現金', icon: '現' }],
      featureSettings: { reconciliations: [checkpoint] }, transactions: [{ id: 'supplement', type: 'expense',
        name: '漏記午餐', amount: 10, category: '飲食', subcategory: '正餐', account: 'cash', date: item.date,
        createdAt: '2026-09-10T04:01:00.000Z' }] });
    const resolved = normalizeLedgerState(JSON.parse(JSON.stringify(resolveAlignedReconciliations(before))));
    const pending = updatePendingSheetChanges({}, before, resolved);
    expect(pending.upserts).toEqual([]);
    expect(pending.featureUpserts.reconciliations).toEqual([item.id]);
    const projected = projectLedgerChangesForSheet(resolved, pending);
    expect(projected.transactions).toEqual([]);
    expect(projected.featureSettingsDelta.reconciliations).toMatchObject([{ id: item.id, includedTransactionIds: ['supplement'] }]);
    const anotherDevice = normalizeLedgerState(reconcileLedgerFromSheet(before, resolved, {}));
    expect(reconciliationAdjustmentStatus(anotherDevice, anotherDevice.featureSettings.reconciliations[0])).toMatchObject({ difference: 0 });
  });
});
