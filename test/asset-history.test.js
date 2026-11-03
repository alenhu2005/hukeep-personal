import { describe, expect, it } from 'vitest';
import { buildAssetHistory } from '../src/domain/asset-history.js';
import { renderInsights } from '../src/views.js';

const accounts = [
  { id: 'cash', name: '現金', openingBalance: 20000 },
  { id: 'investment', name: '投資資產', openingBalance: 10000 },
  { id: 'bito', name: 'Bito', openingBalance: 500 },
];
const range = { from: '2026-10-01', to: '2026-10-03' };
const row = (date, values) => ({ date, ...values });

describe('資產歷史折線圖', () => {
  it('沿用初始金額並累計期初以前交易，不把內部轉帳當成資產增減', () => {
    const rows = buildAssetHistory({ accounts, transactions: [
      row('2026-09-30', { type: 'income', amount: 1000, account: 'cash' }),
      row('2026-10-01', { type: 'transfer', amount: 2000, account: 'cash', toAccount: 'investment', fee: 20 }),
      row('2026-10-02', { type: 'transfer', amount: 300, account: 'cash', toAccount: 'bito' }),
      row('2026-10-03', { type: 'income', amount: 500, account: 'cash' }),
      row('2026-10-04', { type: 'expense', amount: 999, account: 'cash' }),
    ] }, range);
    expect(rows.map(item => item.totalAssets)).toEqual([31500, 31480, 31480, 31980]);
    expect(rows.map(item => item.stocks)).toEqual([10000, 12000, 12000, 12000]);
    expect(rows[0]).toMatchObject({ key: '2026-09-30', label: '期初', stockValued: false });
  });

  it('僅用當時已存在的市值，不將未來市值倒填到歷史；同日市值後買入仍累加', () => {
    const state = { accounts, transactions: [
      row('2026-10-02', { type: 'transfer', amount: 1000, account: 'cash', toAccount: 'investment', createdAt: '2026-10-02T05:00:00Z' }),
    ], featureSettings: { reconciliations: [
      { accountId: 'investment', date: '2026-10-02', createdAt: '2026-10-02T03:00:00Z', actualBalance: 15000 },
      { accountId: 'bito', date: '2026-10-03', actualBalance: 800 },
      { accountId: 'investment', date: '2026-10-05', actualBalance: 99000 },
    ] } };
    const rows = buildAssetHistory(state, range);
    expect(rows.map(item => item.stocks)).toEqual([10000, 10000, 16000, 16000]);
    expect(rows.map(item => item.totalAssets)).toEqual([30500, 30500, 35500, 35800]);
    expect(rows[2].stockValued).toBe(true);
  });

  it('繼承期初前最近市值，賣出與跨銀行轉帳守恆，內扣手續費只扣一次', () => {
    const rows = buildAssetHistory({ accounts, featureSettings: { reconciliations: [
      { accountId: 'investment', date: '2026-09-29', actualBalance: 12000 },
    ] }, transactions: [
      row('2026-10-01', { type: 'transfer', amount: 2000, account: 'investment', toAccount: 'cash', fee: 12, feeMode: 'included' }),
      row('2026-10-02', { type: 'expense', amount: 100, account: 'cash' }),
    ] }, range);
    expect(rows.map(item => item.stocks)).toEqual([12000, 10000, 10000, 10000]);
    expect(rows.map(item => item.totalAssets)).toEqual([32500, 32488, 32388, 32388]);
  });

  it('年度按月結餘並止於觀測日，包含閏年與跨年期初', () => {
    const rows = buildAssetHistory({ accounts }, { from: '2024-01-01', to: '2024-03-03' }, 'year');
    expect(rows.map(item => item.key)).toEqual(['2023-12-31', '2024-01-31', '2024-02-29', '2024-03-03']);
    expect(buildAssetHistory({ accounts }, { from: '2026-12-27', to: '2027-01-02' }, 'week')).toHaveLength(8);
  });

  it('沒有投資帳戶時股票為空，負總資產與零市值也如實呈現', () => {
    expect(buildAssetHistory({ accounts: [{ id: 'cash', openingBalance: -100 }] }, range)[0])
      .toMatchObject({ totalAssets: -100, stocks: null });
    const rows = buildAssetHistory({ accounts, featureSettings: { reconciliations: [
      { accountId: 'investment', date: '2026-10-01', actualBalance: 0 },
    ] } }, range);
    expect(rows[1]).toMatchObject({ stocks: 0, totalAssets: 20500, stockValued: true });
  });

  it('拒絕無效範圍，尚未開始期間不預測未來', () => {
    for (const invalid of [
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026-10-01', to: '2026-09-30' },
      { from: '', to: '2026-10-01' },
    ]) expect(buildAssetHistory({ accounts }, invalid)).toEqual([]);
  });

  it('總覽和投資各顯示獨立折線圖，保留股票/Bito篩選及原有市值紀錄', () => {
    const state = { accounts, transactions: [], budgets: [], featureSettings: { reconciliations: [
      { accountId: 'investment', date: '2026-09-02', actualBalance: 12000 },
    ] } };
    const overview = renderInsights(state, '2026-09');
    expect(overview).toContain('aria-label="總資產變化"');
    expect(overview).toContain('總資產變化折線圖');
    expect(overview).toContain('data-chart-point');
    const investment = renderInsights(state, '2026-09', { insightFilters: { section: 'investment' } });
    expect(investment).toContain('股票資產變化折線圖');
    expect(investment).toContain('查看市值紀錄');
    expect(investment).not.toContain('股票與虛擬貨幣市值紀錄折線圖');
    const bito = renderInsights(state, '2026-09', { insightFilters: { section: 'investment', assetAccount: 'bito' } });
    expect(bito).not.toContain('股票資產變化折線圖');
  });
});
