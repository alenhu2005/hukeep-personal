import { describe, expect, it } from 'vitest';
import {
  buildMonthlyTrend,
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateTotalAssets,
  summarizeMonth,
} from '../src/domain/insights.js';

const transactions = [
  { id: 'e1', type: 'expense', amount: 300, category: '飲食', account: 'cash', date: '2026-08-03' },
  { id: 'e2', type: 'expense', amount: 700, category: '居家', account: 'card', date: '2026-08-04' },
  { id: 'i1', type: 'income', amount: 5000, category: '薪資', account: 'bank', date: '2026-08-01' },
  { id: 't1', type: 'transfer', amount: 1000, category: null, account: 'bank', toAccount: 'cash', date: '2026-08-02' },
  { id: 'old', type: 'expense', amount: 50, category: '飲食', account: 'cash', date: '2026-07-31' },
];

describe('summarizeMonth', () => {
  it('統計指定月份且將轉帳排除於收支', () => {
    expect(summarizeMonth(transactions, '2026-08')).toEqual({
      month: '2026-08',
      income: 5000,
      expense: 1000,
      balance: 4000,
      count: 3,
      byCategory: { '飲食': 300, '居家': 700 },
    });
  });

  it('空月份回傳零值摘要', () => {
    expect(summarizeMonth(transactions, '2025-01')).toMatchObject({
      income: 0,
      expense: 0,
      balance: 0,
      count: 0,
      byCategory: {},
    });
  });
});

describe('buildMonthlyTrend', () => {
  it('可跨年建立連續月份並補零', () => {
    const result = buildMonthlyTrend(
      [
        { type: 'income', amount: 1000, date: '2025-12-01' },
        { type: 'expense', amount: 400, date: '2026-02-01' },
      ],
      '2026-02',
      3,
    );

    expect(result).toEqual([
      { month: '2025-12', income: 1000, expense: 0, balance: 1000 },
      { month: '2026-01', income: 0, expense: 0, balance: 0 },
      { month: '2026-02', income: 0, expense: 400, balance: -400 },
    ]);
  });
});

describe('calculateBudgetProgress', () => {
  it('計算分類預算使用量、餘額與超支狀態', () => {
    const result = calculateBudgetProgress(
      [
        { category: '飲食', limit: 1000 },
        { category: '居家', limit: 500 },
      ],
      transactions,
      '2026-08',
    );

    expect(result).toEqual([
      { category: '飲食', limit: 1000, spent: 300, remaining: 700, ratio: 0.3, status: 'ok' },
      { category: '居家', limit: 500, spent: 700, remaining: -200, ratio: 1.4, status: 'over' },
    ]);
  });
});

describe('calculateAccountBalances', () => {
  it('把收入、支出與轉帳正確套用到帳戶', () => {
    const accounts = [
      { id: 'cash', openingBalance: 100 },
      { id: 'bank', openingBalance: 2000 },
      { id: 'card', openingBalance: 0 },
    ];
    expect(calculateAccountBalances(accounts, transactions)).toEqual([
      { id: 'cash', balance: 750 },
      { id: 'bank', balance: 6000 },
      { id: 'card', balance: -700 },
    ]);
  });
});

describe('calculateTotalAssets', () => {
  it('加總所有帳戶目前餘額，負餘額會扣除', () => {
    expect(calculateTotalAssets([
      { id: 'cash', balance: 750 },
      { id: 'bank', balance: 6000 },
      { id: 'card', balance: -700 },
      { id: 'invalid', balance: Number.NaN },
    ])).toBe(6050);
  });
});
