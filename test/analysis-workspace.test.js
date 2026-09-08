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

  it('轉帳僅把手續費計入所有支出分析及前期比較', () => {
    const transfer = { type: 'transfer', amount: 10000, fee: 150, category: '轉帳', name: '跨行轉帳', date: '2026-08-31' };
    const model = buildAnalysisWorkspace([
      { type: 'expense', amount: 100, category: '飲食', name: '午餐', date: '2026-08-31' },
      transfer,
      { type: 'transfer', amount: 20000, fee: 0, name: '免手續費轉帳', date: '2026-08-31' },
      { type: 'transfer', amount: 30000, fee: 50, date: '2025-08-31' },
    ], { period: 'year', selectedMonth: '2026-08', today: '2026-08-31' });

    expect(model.totals).toEqual({ income: 0, expense: 250 });
    expect(model.previousTotals).toEqual({ income: 0, expense: 50 });
    expect(model.expenseTransactions).toHaveLength(2);
    expect(model.expenseTransactions).toContain(transfer);
    expect(model.categoryRows).toEqual([
      { category: '帳單', amount: 150, percent: 60 },
      { category: '飲食', amount: 100, percent: 40 },
    ]);
    expect(model.dailyRows).toEqual([{ date: '2026-08-31', amount: 250 }]);
    expect(model.monthRows[7]).toEqual({ month: '2026-08', amount: 250 });
    expect(model.monthRows.reduce((sum, row) => sum + row.amount, 0)).toBe(model.totals.expense);
    expect(model.largest).toEqual({ name: '跨行轉帳', amount: 150, date: '2026-08-31' });
    expect(model.insights[1].value).toBe('+400%');
  });

  it.each([
    ['2026-03', '2026-02-01', '2026-02-28', '2026-01-31'],
    ['2024-03', '2024-02-01', '2024-02-29', '2024-01-31'],
    ['2026-02', '2026-01-01', '2026-01-31', '2025-12-31'],
    ['2026-01', '2025-12-01', '2025-12-31', '2025-11-30'],
  ])('%s 月的前期比較涵蓋完整上一個日曆月', (selectedMonth, firstDay, lastDay, outsideDay) => {
    const model = buildAnalysisWorkspace([
      { type: 'expense', amount: 10, date: firstDay },
      { type: 'expense', amount: 20, date: lastDay },
      { type: 'expense', amount: 1000, date: outsideDay },
      { type: 'expense', amount: 60, date: `${selectedMonth}-01` },
    ], { period: 'month', selectedMonth, today: `${selectedMonth}-15` });

    expect(model.previousTotals).toEqual({ income: 0, expense: 30 });
    expect(model.insights[1].value).toBe('+100%');
  });

  it.each(['2024', '2025'])('%s 年的前期比較涵蓋完整上一年，不受閏年天數影響', year => {
    const previousYear = Number(year) - 1;
    const model = buildAnalysisWorkspace([
      { type: 'expense', amount: 10, date: `${previousYear}-01-01` },
      { type: 'expense', amount: 20, date: `${previousYear}-12-31` },
      { type: 'expense', amount: 1000, date: `${previousYear - 1}-12-31` },
      { type: 'expense', amount: 60, date: `${year}-01-01` },
    ], { period: 'year', selectedMonth: `${year}-03`, today: `${year}-03-15` });

    expect(model.previousTotals).toEqual({ income: 0, expense: 30 });
    expect(model.insights[1].value).toBe('+100%');
  });

  it('週比較維持上一個完整七天範圍', () => {
    const model = buildAnalysisWorkspace([
      { type: 'expense', amount: 1000, date: '2026-08-22' },
      { type: 'expense', amount: 10, date: '2026-08-23' },
      { type: 'expense', amount: 20, date: '2026-08-29' },
      { type: 'expense', amount: 60, date: '2026-08-30' },
    ], { period: 'week', selectedMonth: '2026-08', today: '2026-08-31' });

    expect(model.previousTotals).toEqual({ income: 0, expense: 30 });
    expect(model.totals).toEqual({ income: 0, expense: 60 });
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
