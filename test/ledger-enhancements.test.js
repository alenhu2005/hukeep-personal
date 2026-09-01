import { describe, expect, it } from 'vitest';

import {
  applyRecurringRules,
  createMonthlySnapshot,
  findTransactionSignals,
  normalizeFeatureSettings,
  reconciliationStatus,
} from '../src/domain/ledger-enhancements.js';

describe('帳本補強功能', () => {
  it('保留可跨裝置同步的定期、快照與對帳設定', () => {
    expect(normalizeFeatureSettings({
      recurringRules: [{
        id: 'rent', name: '房租', type: 'expense', amount: 12000, category: '居家',
        subcategory: '房租', account: 'line', cadence: 'monthly', day: 5,
        startDate: '2026-01-05', enabled: true,
      }],
      monthlySnapshots: [{ month: '2026-07', assetTotal: 30000, income: 20000, expense: 12000 }],
      reconciliations: [{ id: 'r1', accountId: 'line', actualBalance: 500, date: '2026-08-30' }],
    })).toMatchObject({
      recurringRules: [{ id: 'rent', cadence: 'monthly', day: 5, account: 'line' }],
      monthlySnapshots: [{ month: '2026-07', assetTotal: 30000 }],
      reconciliations: [{ id: 'r1', accountId: 'line', actualBalance: 500 }],
    });
  });

  it('補齊漏掉的定期交易，且不重複建立相同到期日', () => {
    const rules = [{
      id: 'subscription', name: '影音訂閱', type: 'expense', amount: 199, category: '娛樂',
      subcategory: '訂閱', account: 'line', cadence: 'monthly', day: 1,
      startDate: '2026-07-01', enabled: true,
    }];
    const result = applyRecurringRules(rules, [{
      id: 'already-created', type: 'expense', name: '影音訂閱', amount: 199, category: '娛樂',
      account: 'line', date: '2026-07-01', source: 'recurring', sourceId: 'subscription:2026-07-01',
    }], '2026-08-16');

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      name: '影音訂閱', date: '2026-08-01', source: 'recurring', sourceId: 'subscription:2026-08-01',
    });
  });

  it('找出同日同帳戶的重複交易與分類金額異常', () => {
    const signals = findTransactionSignals([
      { id: 'a', type: 'expense', name: '午餐', amount: 100, category: '飲食', account: 'cash', date: '2026-08-01' },
      { id: 'b', type: 'expense', name: '午餐', amount: 100, category: '飲食', account: 'cash', date: '2026-08-01' },
      { id: 'c', type: 'expense', name: '晚餐', amount: 120, category: '飲食', account: 'cash', date: '2026-08-02' },
      { id: 'd', type: 'expense', name: '聚餐', amount: 900, category: '飲食', account: 'cash', date: '2026-08-03' },
    ]);

    expect(signals.duplicates.get('a')).toBe('可能重複');
    expect(signals.duplicates.get('b')).toBe('可能重複');
    expect(signals.anomalies.get('d')).toBe('金額異常');
  });

  it('略過已由使用者確認無誤的提醒，避免持續出現在待確認清單', () => {
    const signals = findTransactionSignals([
      {
        id: 'confirmed', type: 'expense', name: '午餐', amount: 900,
        category: '飲食', account: 'cash', date: '2026-08-01',
        userEditedAt: '2026-08-01T08:00:00.000Z',
      },
      {
        id: 'other', type: 'expense', name: '午餐', amount: 900,
        category: '飲食', account: 'cash', date: '2026-08-01',
      },
    ]);

    expect(signals.duplicates.size).toBe(0);
    expect(signals.anomalies.size).toBe(0);
  });

  it('儲存月結快照並計算對帳差額', () => {
    const snapshot = createMonthlySnapshot({
      accounts: [{ id: 'cash', openingBalance: 1000 }],
      transactions: [{ id: 'a', type: 'expense', amount: 200, account: 'cash', date: '2026-08-02' }],
    }, '2026-08', '2026-09-01T00:00:00.000Z');

    expect(snapshot).toMatchObject({ month: '2026-08', assetTotal: 800, expense: 200 });
    expect(reconciliationStatus(800, 760)).toMatchObject({ difference: -40, status: 'mismatch' });
    expect(reconciliationStatus('800', '800')).toMatchObject({ difference: 0, status: 'matched' });
  });

  it('略過不安全的設定，支援每週與跨月定期轉帳', () => {
    const settings = normalizeFeatureSettings({
      recurringRules: [
        { id: 'bad', name: '壞資料', type: 'expense', amount: -1, category: '飲食', account: 'cash', cadence: 'monthly', startDate: '2026-02-30' },
        { id: 'same', name: '壞轉帳', type: 'transfer', amount: 1, account: 'cash', toAccount: 'cash', cadence: 'weekly', startDate: '2026-08-01' },
        { id: 'move', name: '轉存', type: 'transfer', amount: 1000, fee: 15, account: 'cash', toAccount: 'line', cadence: 'weekly', day: 1, startDate: '2026-08-25' },
        { id: 'off', name: '不建立', type: 'income', amount: 100, category: '薪資', account: 'line', cadence: 'monthly', startDate: '2026-08-01', enabled: false },
      ],
      monthlySnapshots: [
        { month: 'bad', assetTotal: 1 },
        { month: '2026-08', assetTotal: -20, income: 0, expense: 0, accountBalances: [{ id: 'cash', balance: -20 }, { id: '', balance: 3 }] },
      ],
      reconciliations: [{ id: 'bad', accountId: 'cash', actualBalance: 10, date: '2026-02-30' }],
    });
    expect(settings.recurringRules.map(rule => rule.id)).toEqual(['move', 'off']);
    expect(settings.monthlySnapshots[0]).toMatchObject({ assetTotal: -20, accountBalances: [{ id: 'cash', balance: -20 }] });
    expect(settings.reconciliations).toEqual([]);

    const created = applyRecurringRules(settings.recurringRules, [], '2026-09-08').created;
    expect(created.map(item => item.date)).toEqual(['2026-08-25', '2026-09-01', '2026-09-08']);
    expect(created[0]).toMatchObject({ type: 'transfer', toAccount: 'line', fee: 15, source: 'recurring' });
  });

  it('不對沒有重複或剛好在門檻上的資料發出警示', () => {
    const signals = findTransactionSignals([
      { id: 'a', type: 'expense', name: '午餐!', amount: 100, category: '飲食', account: 'cash', date: '2026-08-01' },
      { id: 'b', type: 'income', name: '薪資', amount: 10000, category: '薪資', account: 'cash', date: '2026-08-01' },
      { id: 'c', type: 'expense', name: '晚餐', amount: 500, category: '飲食', account: 'cash', date: '2026-08-02' },
    ]);
    expect(signals.duplicates.size).toBe(0);
    expect(signals.anomalies.size).toBe(0);
  });
});
