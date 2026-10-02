import { describe, expect, it } from 'vitest';
import {
  analysisHeatIntensity,
  buildAnalysisWorkspace,
} from '../src/domain/analysis-workspace.js';
import { renderAnalysisUpgrades } from '../src/views/analysis-upgrades.js';

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

  it('未選大分類時不自行展開其他分類的分析', () => {
    const html = renderAnalysisUpgrades({}, workspace({ category: '' }), { section: 'income', category: '' });
    expect(html).toBe('');
  });

  it('以可鑽取按鈕呈現分類前後期與多選小分類圖表', () => {
    const html = renderAnalysisUpgrades({}, workspace(), {
      section: 'expense', category: '飲食', compareSubcategories: ['午餐', '茶點'],
    });
    expect(html).toContain('data-insight-compare-subcategory="午餐"');
    expect(html).toContain('data-analysis-drill="expense"');
    expect(html).toContain('data-date="2026-09-01" data-start="2026-09-01" data-end="2026-09-01"');
    expect(html).toContain('data-start="2026-10-01" data-end="2026-10-02"');
  });

  it('只在月檢視顯示累計預算，並標示歷史月份使用目前預算設定', () => {
    const month = renderAnalysisUpgrades({}, workspace({ selectedMonth: '2026-09' }), {
      section: 'expense', period: 'month', category: '飲食',
    });
    expect(month).toContain('目前設定的月預算（非歷史版本）');

    const year = renderAnalysisUpgrades({}, workspace({ period: 'year' }), {
      section: 'expense', period: 'year', category: '飲食',
    });
    expect(year).toContain('切換到本月查看累計支出與月預算。');
  });

  it('年檢視的帳戶查詢使用該月截止日，並將未完結月份截在已觀察日期', () => {
    const model = workspace({ period: 'year' });
    expect(model.liquidInvestmentSeries.find(row => row.key === '2026-09'))
      .toMatchObject({ through: '2026-09-30' });
    expect(model.liquidInvestmentSeries.find(row => row.key === '2026-10'))
      .toMatchObject({ through: '2026-10-02' });

    const html = renderAnalysisUpgrades({}, model, { section: 'investment', period: 'year' });
    expect(html).toContain('data-account-group="investment" data-start="0001-01-01" data-end="2026-09-30"');
    expect(html).toContain('data-account-group="investment" data-start="0001-01-01" data-end="2026-10-02"');
  });

  it('保留但無資料的分類或小分類篩選時顯示空狀態，不跳到其他分類', () => {
    const model = workspace({ category: '居家', period: 'month' });
    expect(model.expenseComposition).toBeNull();
    const emptyCategory = renderAnalysisUpgrades({}, model, { section: 'expense', category: '居家' });
    expect(emptyCategory).toContain('本期和對照期都沒有分類資料。');
    expect(emptyCategory).not.toContain('飲食本期與前期');

    const emptySubcategory = renderAnalysisUpgrades({}, workspace(), {
      section: 'expense', category: '飲食', subcategory: '早餐',
    });
    expect(emptySubcategory).toContain('這段期間沒有該小分類資料。');
  });
});
