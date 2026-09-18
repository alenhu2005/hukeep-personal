import { describe, expect, it } from 'vitest';
import { renderHistory, renderInsights, renderOverview, transactionRows } from '../src/views.js';

describe('交易列表', () => {
  it('以名稱為主文字，列表只保留分類與日期並安全跳脫', () => {
    const html = transactionRows(
      [
        {
          id: 'tx-1',
          type: 'expense',
          amount: 180,
          category: '飲食',
          subcategory: '咖啡',
          account: 'line',
          toAccount: null,
          date: '2026-08-29',
          name: '<b>星巴克</b>',
          note: '和朋友聊天',
        },
      ],
      [{ id: 'line', name: 'LINE' }],
    );
    expect(html).toContain('<strong>&lt;b&gt;星巴克&lt;/b&gt;</strong>');
    expect(html).toContain('data-detail-id="tx-1"');
    expect(html).toContain('aria-label="查看 &lt;b&gt;星巴克&lt;/b&gt; 詳情"');
    expect(html).not.toContain('和朋友聊天');
    expect(html).toContain('飲食 · 咖啡 · 8/29');
    expect(html).not.toContain('<b>星巴克</b>');
  });

  it('不在交易卡片標示背景異常或重複判斷', () => {
    const html = transactionRows([
      {
        id: 'tx-attention', type: 'expense', amount: 30010,
        category: '學習', subcategory: '課程', account: 'post', date: '2026-08-30', name: '學費', note: '',
      },
    ], [{ id: 'post', name: '郵局' }], {
      signals: { duplicates: new Map([['tx-attention', '可能重複']]), anomalies: new Map([['tx-attention', '金額異常']]) },
    });

    expect(html).not.toContain('金額異常');
    expect(html).not.toContain('可能重複');
    expect(html).not.toContain('data-attention');
  });
});

describe('總覽', () => {
  it('顯示所有帳戶餘額加總的總資產', () => {
    const html = renderOverview({
      accounts: [
        { id: 'cash', name: '現金', icon: '現', openingBalance: 3000 },
        { id: 'line', name: 'LINE', icon: 'L', openingBalance: -500 },
      ],
      transactions: [
        { id: 'income', type: 'income', amount: 1000, account: 'cash', date: '2026-08-01' },
        { id: 'expense', type: 'expense', amount: 200, account: 'line', date: '2026-08-01' },
      ],
      budgets: [],
    }, '2026-08');

    expect(html).toContain('總資產');
    expect(html).toContain('data-testid="total-assets">NT$ 3,300</strong>');
    expect(html).toContain('<h1 id="overview-title">總覽</h1>');
    expect(html).not.toContain('先看流向');
    expect(html).not.toContain('收入還有空間');
    expect(html).not.toContain('平均每筆');
    expect(html).toContain('data-testid="summary-income"');
    expect(html).toContain('data-testid="summary-expense"');
  });
});

describe('紀錄篩選與月份', () => {
  const accounts = [{ id: 'cash', name: '現金', icon: '現', openingBalance: 0 }];
  const transactions = [{
    id: 'attention-1', type: 'expense', amount: 800, category: '飲食', subcategory: '便當',
    account: 'cash', date: '2026-09-01', name: '午餐', note: '',
  }];

  it('紀錄頁能切換月份，且需確認篩選會說明下一步', () => {
    const html = renderHistory({ accounts, transactions }, '2026-09', {
      query: '', type: '', account: '', preset: 'attention',
    });

    expect(html).toContain('aria-label="切換月份"');
    expect(html).toContain('data-month-shift="-1"');
    expect(html).toContain('data-month-shift="1"');
    expect(html).toContain('查看原因後確認無誤');
    expect(html).toContain('data-history-preset="attention" aria-pressed="true"');
  });
});

describe('趨勢每日淨額', () => {
  it('以每日收支淨額標示紅色支出與綠色收入', () => {
    const html = renderInsights({
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 0 }],
      transactions: [
        { id: 'loss', type: 'expense', amount: 120, category: '飲食', account: 'cash', date: '2026-09-01', name: '午餐' },
        { id: 'gain', type: 'income', amount: 200, category: '薪資', account: 'cash', date: '2026-09-02', name: '薪水' },
      ],
      budgets: [],
    }, '2026-09', { insightFilters: { period: 'month', section: 'overview', selectedDate: '', anchorDate: '2026-09-01' } });

    expect(html).toContain('data-insight-date="2026-09-01"');
    expect(html).toContain('analysis-net-negative');
    expect(html).toContain('-120');
    expect(html).toContain('analysis-net-positive');
    expect(html).toContain('+200');
    expect(html).toContain('analysis-heat-3');
    expect(html).toContain('analysis-heat-5');
    expect(html).toContain('data-insight-section="overview"');
    expect(html).toContain('data-insight-section="expense"');
    expect(html).toContain('data-insight-section="income"');
    expect(html).toContain('data-insight-section="investment"');
    expect(html).not.toContain('analysis-history-section');
  });

  it('把當日摘要與交易明細緊接放在時間圖後', () => {
    const html = renderInsights({
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 0 }],
      transactions: [
        { id: 'income', type: 'income', amount: 500, category: '接案', subcategory: '家教', account: 'cash', date: '2026-09-02', name: '家教' },
        { id: 'meal', type: 'expense', amount: 100, category: '飲食', subcategory: '便當', account: 'cash', date: '2026-09-02', name: '午餐' },
        { id: 'buy', type: 'transfer', amount: 300, category: '投資', subcategory: 'ETF', account: 'cash', toAccount: 'investment', date: '2026-09-02', name: '0050' },
      ],
      budgets: [],
    }, '2026-09', {
      insightFilters: { period: 'month', section: 'overview', category: '', subcategory: '', selectedDate: '2026-09-02', anchorDate: '2026-09-02' },
    });

    expect(html).toContain('當日明細');
    expect(html).toContain('投資投入');
    expect(html).toContain('生活結餘');
    expect(html.indexOf('analysis-history-section')).toBeLessThan(html.indexOf('analysis-section-tabs'));
    expect(html).toContain('午餐');
  });

  it('支出分頁可顯示大分類排行、小分類圖表、趨勢與明細', () => {
    const html = renderInsights({
      accounts: [
        { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
        { id: 'line', name: 'LINE', icon: 'L', openingBalance: 0 },
      ],
      transactions: [
        { id: 'tea', type: 'expense', amount: 45, category: '飲食', subcategory: '飲料', account: 'line', date: '2026-09-01', name: '紅茶' },
        { id: 'meal', type: 'expense', amount: 100, category: '飲食', subcategory: '便當', account: 'cash', date: '2026-09-02', name: '午餐' },
      ],
      budgets: [{ category: '飲食', limit: 3000 }],
    }, '2026-09', {
      insightFilters: { period: 'month', section: 'expense', category: '飲食', subcategory: '飲料', selectedDate: '', anchorDate: '2026-09-02' },
    });

    expect(html).toContain('aria-label="支出大分類排行"');
    expect(html).toContain('data-insight-category="飲食"');
    expect(html).toContain('aria-label="飲食小分類圖表"');
    expect(html).toContain('data-insight-subcategory="飲料"');
    expect(html).toContain('analysis-time-bars');
    expect(html).toContain('analysis-account-bars');
    expect(html).toContain('紅茶');
    expect(html).not.toContain('analysis-donut');
    expect(html).not.toContain('分析重點');
  });

  it('獨立顯示投資投入、領回、淨投入與小分類圖表', () => {
    const html = renderInsights({
      accounts: [],
      transactions: [
        { id: 'buy', type: 'transfer', amount: 10000, category: '投資', subcategory: 'ETF', account: 'sinopac', toAccount: 'investment', date: '2026-09-01', name: '0050' },
        { id: 'sell', type: 'transfer', amount: 3000, category: '投資', subcategory: '股票', account: 'investment', toAccount: 'sinopac', date: '2026-09-02', name: '賣出股票' },
      ],
      budgets: [],
    }, '2026-09', { insightFilters: { period: 'month', section: 'investment', selectedDate: '', anchorDate: '2026-09-01' } });

    expect(html).toContain('投資流向');
    expect(html).toContain('淨投入');
    expect(html).toContain('NT$ 10,000');
    expect(html).toContain('NT$ 3,000');
    expect(html).toContain('investment-split-bar');
  });
});

describe('轉帳列表', () => {
  it('在轉帳紀錄中顯示手續費', () => {
    const html = transactionRows([
      {
        id: 'transfer-1', type: 'transfer', amount: 300, fee: 15,
        account: 'cash', toAccount: 'line', date: '2026-08-29', name: '轉入 LINE', note: '',
      },
    ], [
      { id: 'cash', name: '現金' },
      { id: 'line', name: 'LINE' },
    ]);

    expect(html).toContain('手續費 NT$ 15');
  });
});
