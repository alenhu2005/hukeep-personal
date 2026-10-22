import { describe, expect, it } from 'vitest';
import {
  analysisHeatIntensity,
  buildAnalysisWorkspace,
} from '../src/domain/analysis-workspace.js';
import { renderAnalysisTool } from '../src/views/analysis-upgrades.js';

const accounts = [
  { id: 'cash', name: '現金', openingBalance: 100 },
  { id: 'investment', name: '投資資產', openingBalance: 500 },
];

const transactions = [
  { id: 'meal-1', type: 'expense', amount: 200, category: '飲食', subcategory: '午餐', merchant: '市場', account: 'cash', date: '2026-10-01' },
  { id: 'salary', type: 'income', amount: 1000, category: '薪資', account: 'cash', date: '2026-10-01' },
  { id: 'client', type: 'income', amount: 250, category: '接案', subcategory: '家教', account: 'cash', date: '2026-10-01' },
  { id: 'invest', type: 'transfer', amount: 50, category: '投資', subcategory: 'ETF', account: 'cash', toAccount: 'investment', date: '2026-10-01' },
  { id: 'meal-2', type: 'expense', amount: 100, category: '飲食', subcategory: '茶點', merchant: '市場', account: 'cash', date: '2026-10-02' },
  { id: 'refund', type: 'income', amount: 50, category: '飲食', subcategory: '午餐', refundOf: 'meal-1', merchant: '市場', account: 'cash', date: '2026-10-02' },
  { id: 'transit', type: 'expense', amount: 20, category: '交通', name: '捷運', account: 'cash', date: '2026-10-02' },
  { id: 'old-1', type: 'expense', amount: 100, category: '飲食', subcategory: '午餐', date: '2026-09-01' },
  { id: 'old-2', type: 'expense', amount: 50, category: '飲食', subcategory: '午餐', date: '2026-09-02' },
  { id: 'outside-match', type: 'expense', amount: 700, category: '飲食', date: '2026-09-03' },
  { id: 'old-income', type: 'income', amount: 100, category: '接案', subcategory: '家教', date: '2026-09-01' },
];

function workspace(options = {}) {
  return buildAnalysisWorkspace(transactions, {
    period: 'month', selectedMonth: '2026-10', today: '2026-10-02', currentDate: '2026-10-02',
    category: '飲食', section: 'expense',
    budgets: [{ category: '飲食', limit: 3100 }],
    accounts,
    reconciliations: [{ id: 'investment-check', accountId: 'investment', actualBalance: 600, date: '2026-10-01', createdAt: '2026-10-01T23:00:00.000Z' }],
    ...options,
  });
}

describe('分析升級圖表資料', () => {
  it('使用等長前期比較，並同時彙總收入與帶符號支出', () => {
    const model = workspace();
    expect(model.incomeExpenseSeries).toEqual([
      { key: '2026-10-01', label: '10/1', income: 1250, expense: 200 },
      { key: '2026-10-02', label: '10/2', income: 0, expense: 70 },
    ]);
    const food = model.expenseComparisonSeries.find(row => row.category === '飲食');
    expect(food).toMatchObject({ amount: 250, previousAmount: 150, changeAmount: 100 });
    expect(food.series.map(row => [row.key, row.previousKey, row.amount, row.previousAmount])).toEqual([
      ['2026-10-01', '2026-09-01', 200, 100],
      ['2026-10-02', '2026-09-02', 50, 50],
    ]);
    expect(model.incomeComparisonSeries.find(row => row.category === '接案').series[0])
      .toMatchObject({ amount: 250, previousAmount: 100 });
    expect(model.expenseChanges[0]).toMatchObject({ category: '飲食', changeAmount: 100, changePercent: 67 });
    expect(model.expenseChanges.find(row => row.category === '交通').changePercent).toBeNull();
  });

  it('提供按日攤提預算、商家與品項排名、實際本金及真實對帳點', () => {
    const model = workspace();
    expect(model.budgetCumulativeSeries[0].series[1]).toMatchObject({ amount: 250, proratedBudget: 200 });
    expect(model.merchantGroups.find(row => row.kind === 'merchant' && row.merchant === '市場'))
      .toMatchObject({ label: '市場', amount: 250, count: 3 });
    expect(model.merchantGroups.find(row => row.name === '捷運')).toMatchObject({ kind: 'item', amount: 20 });
    expect(model.liquidInvestmentSeries).toEqual([
      { key: '2026-10-01', through: '2026-10-01', label: '10/1', liquid: 1100, investmentPrincipal: 550 },
      { key: '2026-10-02', through: '2026-10-02', label: '10/2', liquid: 1030, investmentPrincipal: 550 },
    ]);
    expect(model.investmentCheckpoints).toEqual([
      { date: '2026-10-01', principal: 550, marketValue: 600 },
    ]);
  });

  it('正負共用連續熱度，金額增加時平滑變深且不超出可讀範圍', () => {
    const values = [0, 100, 101, 500, 501, 2000, 2001, 10000, 10001, 100000000].map(analysisHeatIntensity);
    expect(values[0]).toBe(0);
    values.slice(1).forEach((value, index) => {
      expect(value).toBeGreaterThan(values[index]);
      expect(value).toBeLessThan(72);
    });
    expect(analysisHeatIntensity(101) - analysisHeatIntensity(100)).toBeLessThan(.1);
    expect(analysisHeatIntensity(-501)).toBe(analysisHeatIntensity(501));
    expect(analysisHeatIntensity(Infinity)).toBe(0);
    expect(analysisHeatIntensity('invalid')).toBe(0);
  });

  it('只渲染使用者指定的進階工具', () => {
    expect(renderAnalysisTool(workspace(), { section: 'expense', tool: '' })).toBe('');
    const html = renderAnalysisTool(workspace(), { section: 'expense', category: '飲食', tool: 'composition' });
    expect(html).toContain('小分類構成走勢');
    expect(html).toContain('data-analysis-drill="expense"');
    expect(html).not.toContain('比較多個小分類');
  });

  it('只在月檢視顯示累計預算，歷史月份明示目前設定', () => {
    expect(renderAnalysisTool(workspace({ selectedMonth: '2026-09' }), { period: 'month', tool: 'budget' }))
      .toContain('目前設定的月預算（非歷史版本）');
    expect(renderAnalysisTool(workspace({ period: 'year' }), { period: 'year', tool: 'budget' }))
      .toContain('切換到本月查看累計支出與月預算。');
  });

  it('本金工具的年度查詢保留各月截止日與已觀察日期', () => {
    const model = workspace({ period: 'year' });
    const html = renderAnalysisTool(model, { period: 'year', tool: 'principal' });
    expect(html).toContain('data-account-group="investment" data-start="0001-01-01" data-end="2026-09-30"');
    expect(html).toContain('data-account-group="investment" data-start="0001-01-01" data-end="2026-10-02"');
  });

  it('無資料的分類工具不自行替換成其他分類', () => {
    const html = renderAnalysisTool(workspace({ category: '居家' }), { section: 'expense', category: '居家', tool: 'composition' });
    expect(html).not.toContain('飲食 · 所有日期');
  });
});
