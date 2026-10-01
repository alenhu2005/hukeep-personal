import { describe, expect, it } from 'vitest';
import { forecastBudgetProgress, removeBudget, upsertBudget } from '../src/domain/budgets.js';

describe('預算設定', () => {
  it('新增預算時不改動原陣列', () => {
    const original = [{ category: '飲食', limit: 5000 }];
    const result = upsertBudget(original, { category: '交通', limit: 2000 });
    expect(result).toEqual([
      { category: '飲食', limit: 5000 },
      { category: '交通', limit: 2000 },
    ]);
    expect(original).toHaveLength(1);
  });

  it('相同分類會更新而不會重複', () => {
    expect(upsertBudget([{ category: '飲食', limit: 5000 }], { category: '飲食', limit: 6000 })).toEqual([
      { category: '飲食', limit: 6000 },
    ]);
  });

  it('拒絕空分類、零與非整數上限', () => {
    expect(() => upsertBudget([], { category: '', limit: 100 })).toThrow('分類');
    expect(() => upsertBudget([], { category: '飲食', limit: 0 })).toThrow('預算');
    expect(() => upsertBudget([], { category: '飲食', limit: 1.5 })).toThrow('預算');
  });

  it('移除指定分類且不改動原陣列', () => {
    const original = [
      { category: '飲食', limit: 5000 },
      { category: '交通', limit: 2000 },
    ];
    expect(removeBudget(original, '飲食')).toEqual([{ category: '交通', limit: 2000 }]);
    expect(original).toHaveLength(2);
  });

  it('用本月累積支出推估月底金額與超支額', () => {
    expect(forecastBudgetProgress([
      { category: '飲食', limit: 2500 },
      { category: '交通', limit: 2000 },
      { category: '衣著', limit: 2000 },
    ], [
      { type: 'expense', category: '飲食', amount: 1000, date: '2026-08-01' },
      { type: 'expense', category: '交通', amount: 600, date: '2026-08-09' },
      { type: 'income', category: '薪資', amount: 100000, date: '2026-08-10' },
      { type: 'expense', category: '飲食', amount: 800, date: '2026-07-31' },
    ], '2026-08', '2026-08-10')).toEqual([
      { category: '飲食', limit: 2500, spent: 1000, expectedExpense: 3100, expectedOverage: 600 },
      { category: '交通', limit: 2000, spent: 600, expectedExpense: 1860, expectedOverage: 0 },
      { category: '衣著', limit: 2000, spent: 0, expectedExpense: null, expectedOverage: null },
    ]);
  });

  it('不推估未滿七天、沒有支出或非本月資料', () => {
    const budgets = [{ category: '飲食', limit: 1000 }];
    expect(forecastBudgetProgress(budgets, [], '2026-08', '2026-08-06')[0])
      .toMatchObject({ expectedExpense: null, expectedOverage: null });
    expect(forecastBudgetProgress(budgets, [], '2026-08', '2026-08-10')[0])
      .toMatchObject({ expectedExpense: null, expectedOverage: null });
    expect(forecastBudgetProgress(budgets, [], '2026-07', '2026-08-10')[0])
      .toMatchObject({ expectedExpense: null, expectedOverage: null });
  });
});
