import { describe, expect, it } from 'vitest';
import { removeBudget, upsertBudget } from '../src/domain/budgets.js';

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
});
