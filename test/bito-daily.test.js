import { describe, expect, it } from 'vitest';
import { createEmptyState, normalizeLedgerState } from '../src/storage/ledger-repository.js';
import { createTransaction } from '../src/domain/transactions.js';
import { calculateAccountBalances, summarizeMonth } from '../src/domain/insights.js';
import { investmentAccountValues, investmentAssetHistory } from '../src/domain/investment-valuation.js';
import { summarizeInvestmentFlows } from '../src/domain/investment-accounting.js';
import { applyRecurringRules, createMonthlySnapshot, normalizeFeatureSettings } from '../src/domain/ledger-enhancements.js';
import { budgetDailyAverages, forecastBudgetProgress } from '../src/domain/budgets.js';
import { parseSpokenTransactions } from '../src/domain/spoken-entry.js';
import { projectLedgerForSheet } from '../src/services/import-proxy.js';

describe('Bito 與證券分開計價', () => {
  it('補上穩定 ID 的 Bito，保留原投資與交易並可往返備份與 Sheet', () => {
    const original = createEmptyState();
    original.accounts = original.accounts.filter(account => account.id !== 'bito');
    const next = normalizeLedgerState(original);
    expect(next.accounts.find(account => account.id === 'bito')).toMatchObject({ name: 'Bito', openingBalance: 0 });
    expect(normalizeLedgerState(next)).toEqual(next);
    expect(projectLedgerForSheet(next).accounts.filter(account => account.id === 'bito')).toHaveLength(1);
  });

  it('入金只移動資產；證券與 Bito 內轉不灌大投入領回，費用才算支出', () => {
    const state = createEmptyState();
    state.accounts.find(account => account.id === 'sinopac').openingBalance = 10000;
    const tx = createTransaction({ type: 'transfer', name: 'Bito 入金', amount: 1000, fee: 10,
      feeMode: 'included', account: 'sinopac', toAccount: 'bito', date: '2026-10-10' }, { id: 'buy' });
    expect(tx).toMatchObject({ category: '投資', subcategory: '加密資產' });
    state.transactions = [tx];
    const total = calculateAccountBalances(state.accounts, state.transactions).reduce((sum, account) => sum + account.balance, 0);
    expect(total).toBe(10000 + 12891 - 10);
    expect(summarizeMonth(state.transactions, '2026-10').expense).toBe(10);
    expect(summarizeInvestmentFlows(state.transactions)).toMatchObject({ contributed: 990, withdrawn: 0 });
    expect(summarizeInvestmentFlows([{ ...tx, account: 'investment' }])).toMatchObject({ contributed: 0, withdrawn: 0 });
  });

  it('兩帳戶市值獨立、後續轉帳不重複算入，月結使用各自市值', () => {
    const state = createEmptyState();
    state.transactions = [{ id: 'late', type: 'transfer', category: '投資', amount: 300,
      account: 'sinopac', toAccount: 'bito', date: '2026-10-15', createdAt: '2026-10-15T03:00:00Z' }];
    state.featureSettings.reconciliations = [
      { id: 'stock', accountId: 'investment', actualBalance: 15000, date: '2026-10-10', createdAt: '2026-10-10T01:00:00Z' },
      { id: 'coin', accountId: 'bito', actualBalance: 2000, date: '2026-10-10', createdAt: '2026-10-10T01:00:00Z' },
    ];
    const values = investmentAccountValues(state);
    expect(values.map(account => account.balance)).toEqual([15000, 2300]);
    expect(createMonthlySnapshot(state, '2026-10').accountBalances.find(account => account.id === 'bito').balance).toBe(2300);
    expect(projectLedgerForSheet(normalizeLedgerState(JSON.parse(JSON.stringify(state)))).featureSettings.reconciliations).toHaveLength(2);
  });

  it('歷史圖只用指定期間的實際紀錄，同日保留最後市值，未記錄不虛構', () => {
    const state = createEmptyState();
    state.featureSettings.reconciliations = [
      { id: 'a', accountId: 'bito', actualBalance: 1000, date: '2026-10-02', createdAt: '2026-10-02T01:00:00Z' },
      { id: 'b', accountId: 'bito', actualBalance: 1200, date: '2026-10-02', createdAt: '2026-10-02T02:00:00Z' },
      { id: 'c', accountId: 'bito', actualBalance: 1500, date: '2026-10-10' },
      { id: 'd', accountId: 'bito', actualBalance: 9000, date: '2026-11-01' },
    ];
    const rows = investmentAssetHistory(state, { from: '2026-10-01', to: '2026-10-21' });
    expect(rows.find(account => account.id === 'investment').points).toEqual([]);
    expect(rows.find(account => account.id === 'bito')).toMatchObject({ change: 300,
      points: [{ date: '2026-10-02', value: 1200 }, { date: '2026-10-10', value: 1500 }] });
  });

  it('口語買入與賣出 Bito 使用虛擬貨幣帳戶', () => {
    expect(parseSpokenTransactions('永豐在 Bito 買比特幣1000元', { today: '2026-10-21' })[0])
      .toMatchObject({ type: 'transfer', account: 'sinopac', toAccount: 'bito', subcategory: '加密資產' });
    expect(parseSpokenTransactions('Bito賣出比特幣1000元匯到永豐', { today: '2026-10-21' })[0])
      .toMatchObject({ type: 'transfer', account: 'bito', toAccount: 'sinopac' });
  });
});

describe('每日固定流水與預算日平均', () => {
  const input = { id: 'daily', name: '每日投資', type: 'transfer', amount: 100, account: 'sinopac', toAccount: 'bito',
    cadence: 'daily', startDate: '2026-01-01', enabled: true };

  it('每日跨月閏年補登，穩定 ID 重開不重複，暫停與未到期不建立', () => {
    const rule = normalizeFeatureSettings({ recurringRules: [{ ...input, startDate: '2024-02-28' }] }).recurringRules[0];
    expect(rule).toMatchObject({ cadence: 'daily', category: '投資', subcategory: '加密資產' });
    const { created } = applyRecurringRules([rule], [], '2024-03-01');
    expect(created.map(row => row.date)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(applyRecurringRules([rule], created, '2024-03-01').created).toEqual([]);
    expect(applyRecurringRules([{ ...rule, enabled: false }], [], '2024-03-01').created).toEqual([]);
    expect(applyRecurringRules([rule], [], '2024-02-27').created).toEqual([]);
  });

  it('每日超過 104 天後仍繼續補登而不永久停止，多裝置生成相同 ID', () => {
    const rule = normalizeFeatureSettings({ recurringRules: [input] }).recurringRules[0];
    const first = applyRecurringRules([rule], [], '2026-05-01').created;
    expect(first).toHaveLength(104);
    const second = applyRecurringRules([rule], first, '2026-05-01').created;
    expect(second).toHaveLength(17);
    expect(new Set([...first, ...second].map(row => row.id)).size).toBe(121);
    expect(applyRecurringRules([rule], [], '2026-05-01').created).toEqual(first);
  });

  it('日平均包含零消費日，排除未來、投資本金，歷史按整月、未來為 —', () => {
    const budgets = [{ category: '飲食', limit: 5000 }];
    const transactions = [
      { type: 'expense', category: '飲食', amount: 420, date: '2026-10-01' },
      { type: 'expense', category: '飲食', amount: 999, date: '2026-10-22' },
      { type: 'transfer', category: '投資', amount: 10000, account: 'sinopac', toAccount: 'bito', date: '2026-10-01' },
    ];
    expect(budgetDailyAverages(budgets, transactions, '2026-10', '2026-10-21')[0]).toMatchObject({ dailyAverage: 20, days: 21 });
    expect(forecastBudgetProgress(budgets, transactions, '2026-10', '2026-10-21')[0].expectedExpense).toBe(620);
    expect(budgetDailyAverages(budgets, transactions, '2026-10', '2026-11-01')[0]).toMatchObject({ dailyAverage: 46, days: 31 });
    expect(budgetDailyAverages(budgets, transactions, '2026-11', '2026-10-21')[0].dailyAverage).toBeNull();
  });
});
