import { describe, expect, it } from 'vitest';
import { analysisRange, buildAnalysisWorkspace } from '../src/domain/analysis-workspace.js';

describe('分析工作台', () => {
  it('可建立週、月、年範圍', () => {
    expect(analysisRange('week', '2026-08', '2026-08-31')).toEqual({ from: '2026-08-30', to: '2026-09-05', label: '08/30～09/05' });
    expect(analysisRange('month', '2026-02', '2026-08-31')).toEqual({ from: '2026-02-01', to: '2026-02-28', label: '2026-02' });
    expect(analysisRange('year', '2026-08', '2026-08-31')).toEqual({ from: '2026-01-01', to: '2026-12-31', label: '2026 年' });
  });

  it('把範圍內收支、分類、每日合計與前期比較分開計算', () => {
    const transactions = [
      { type: 'expense', amount: 120, category: '飲食', name: '午餐', date: '2026-08-30' },
      { type: 'expense', amount: 60, category: '交通', name: '捷運', date: '2026-08-31' },
      { type: 'income', amount: 1000, category: '接案', name: '家教', date: '2026-08-31' },
      { type: 'expense', amount: 90, category: '飲食', name: '早餐', date: '2026-08-24' },
    ];
    const model = buildAnalysisWorkspace(transactions, { period: 'week', selectedMonth: '2026-08', today: '2026-08-31' });
    expect(model.totals).toEqual({ income: 1000, expense: 180 });
    expect(model.categoryRows[0]).toMatchObject({ category: '飲食', amount: 120, percent: 67 });
    expect(model.dailyRows).toEqual([{ date: '2026-08-30', amount: 120 }, { date: '2026-08-31', amount: 60 }]);
    expect(model.previousTotals.expense).toBe(90);
  });

  it('對不完整的錨點安全回退，並處理空白或沒有前期資料的期間', () => {
    expect(analysisRange('unknown', 'bad-month', '2026-03-04')).toEqual({
      from: '2026-03-01', to: '2026-03-31', label: '2026-03',
    });
    const model = buildAnalysisWorkspace([], { period: 'month', selectedMonth: 'bad', today: '2026-03-04' });
    expect(model.totals).toEqual({ income: 0, expense: 0 });
    expect(model.categoryRows).toEqual([]);
    expect(model.insights.map(item => item.value)).toEqual(['尚無支出', '尚無可比較資料', '尚無資料']);
    expect(buildAnalysisWorkspace(undefined, { period: 'week', selectedMonth: '2026-03', today: '2026-03-04' }).scoped).toEqual([]);
  });

  it('年度視圖只彙總 12 個月份，不建立 365 個日格', () => {
    const model = buildAnalysisWorkspace([
      { type: 'expense', amount: 300, category: '飲食', name: '午餐', date: '2026-01-05' },
      { type: 'expense', amount: 80, category: '交通', name: '捷運', date: '2026-08-31' },
    ], { period: 'year', selectedMonth: '2026-08', today: '2026-08-31' });
    expect(model.monthRows).toHaveLength(12);
    expect(model.monthRows[0]).toEqual({ month: '2026-01', amount: 300 });
    expect(model.monthRows[7]).toEqual({ month: '2026-08', amount: 80 });
    expect(model.monthRows[11]).toEqual({ month: '2026-12', amount: 0 });
  });

  it('不完整的交易仍會保留在安全的預設分類與年度彙總中', () => {
    const model = buildAnalysisWorkspace([
      { type: 'expense', date: '2026-02-03', amount: undefined, category: '', name: '' },
      { type: 'expense', date: '2026-02-04', amount: 40, category: '', name: '' },
    ], { period: 'year', selectedMonth: '2026-08', today: '2026-08-31' });

    expect(model.categoryRows).toEqual([{ category: '其他', amount: 40, percent: 100 }]);
    expect(model.monthRows[1]).toEqual({ month: '2026-02', amount: 40 });
    expect(model.insights[2].value).toBe('未命名 · 40');
  });
});
