import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAnalysisWorkspace } from '../src/domain/analysis-workspace.js';
import { buildCategoryMovers, buildPace, buildTrendSeries } from '../src/domain/analysis-trends.js';
import { classifyLocally, EXPENSE_TAXONOMY, INCOME_TAXONOMY } from '../src/domain/category-taxonomy.js';
import { nextRecurringDate } from '../src/domain/ledger-enhancements.js';
import { createEmptyState } from '../src/storage/ledger-repository.js';
import { previewBackupRestore } from '../src/backup.js';
import { classifyExpenseWithAi, enqueueSpokenEntry, syncLedgerChangesToSheet } from '../src/services/import-proxy.js';
import { renderInsights } from '../src/views.js';

describe('統一分析資料', () => {
  it('摘要、分類與時序使用相同已經過日期，月曆與指定日期仍能查未來紀錄', () => {
    const rows = [
      { id: 'old', type: 'expense', amount: 30, category: '飲食', date: '2026-09-01' },
      { id: 'past', type: 'expense', amount: 100, category: '飲食', subcategory: '飲料', date: '2026-10-01' },
      { id: 'future', type: 'expense', amount: 900, category: '飲食', subcategory: '便當', date: '2026-10-25' },
    ];
    const model = buildAnalysisWorkspace(rows, { period: 'month', selectedMonth: '2026-10', today: '2026-10-02', currentDate: '2026-10-02', selectedDate: '2026-10-25', section: 'expense', category: '飲食', includeAdvanced: false });
    expect(model.totals.expense).toBe(100);
    expect(model.focus.amount).toBe(100);
    expect(model.focus.timeSeries.reduce((sum, row) => sum + row.amount, 0)).toBe(100);
    expect(model.focus.children).toHaveLength(1);
    expect(model.selectedDay.totals.expense).toBe(900);
    expect(model.periodRows).toHaveLength(2);
    expect(model.expenseComparisonSeries).toEqual([]);
    expect(model.liquidInvestmentSeries).toEqual([]);
    expect(model.comparison.hasData).toBe(true);
  });

  it('所選小分類不存在時不默默改用大分類；未來期間顯示空資料', () => {
    const row = { type: 'expense', amount: 50, category: '飲食', subcategory: '飲料', date: '2026-10-02' };
    expect(buildAnalysisWorkspace([row], { selectedMonth: '2026-10', currentDate: '2026-10-22', section: 'expense', category: '飲食', subcategory: '咖啡' }).focus).toBeNull();
    const model = buildAnalysisWorkspace([row], { period: 'year', selectedMonth: '2027-01', currentDate: '2026-10-22' });
    expect(model.totals).toEqual({ income: 0, expense: 0 });
    expect(model.incomeExpenseSeries).toEqual([]);
    expect(model.comparison.elapsedDays).toBe(0);
    expect(model.comparison.hasData).toBe(false);
  });
});

describe('更多具體分類', () => {
  it('AI 回傳其他時保留已辨識的具體本機分類', async () => {
    const fallback = classifyLocally({ items: ['剪髮'] });
    expect(await classifyExpenseWithAi({ endpoint: 'https://taxonomy.example/proxy', merchant: '剪髮', fallback }, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: { topCategory: '其他', subcategory: '其他支出', confidence: .8 } })),
    })).toEqual(fallback);
  });

  it('新分類待審資料遇舊 GAS 先留本機，更新後以相同 ID 續傳', async () => {
    const calls = [];
    let upgraded = false;
    const tx = { id: 'new-category', type: 'expense', amount: 300, account: 'cash', category: '個人照護', subcategory: '理髮', date: '2026-10-22', source: 'voice', aiStatus: 'pending' };
    const input = { endpoint: 'https://taxonomy-version.example/proxy', transcript: '剪髮300', draft: tx };
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return new Response(JSON.stringify({ ok: true, data: body.action === 'getLedgerCapabilities' ? { enhancementsVersion: 1, ...(upgraded ? { categoryTaxonomyVersion: 2 } : {}) } : { queueId: 'taxonomy-queue', status: 'pending', transactions: [tx] } }));
    };
    await expect(enqueueSpokenEntry(input, { fetchImpl })).rejects.toThrow('已保留本機');
    await expect(syncLedgerChangesToSheet({ endpoint: input.endpoint, state: { transactions: [tx] }, changes: { upserts: [tx.id] } }, { fetchImpl })).rejects.toThrow('已保留本機');
    expect(calls.every(row => row.action === 'getLedgerCapabilities')).toBe(true);
    upgraded = true;
    expect((await enqueueSpokenEntry(input, { fetchImpl })).transactions[0]).toMatchObject({ id: tx.id, category: '個人照護', subcategory: '理髮' });
  });

  it.each([
    ['剪髮 300', '個人照護', '理髮'], ['健身房月費 1000', '運動健身', '健身房'],
    ['民宿住宿', '旅遊', '住宿'], ['托嬰費', '家庭育兒', '托育'],
    ['Spotify 月費', '訂閱服務', '音樂串流'], ['郵寄包裹', '行政規費', '郵寄宅配'],
    ['辣味鍋貼', '飲食', '鍋貼水餃'], ['玉米濃湯', '飲食', '湯品'], ['黑豆漿', '飲食', '飲料'],
    ['停車費', '交通', '停車'], ['影印紙', '工作', '辦公用品'], ['午餐便當', '飲食', '便當'],
  ])('%s 可在離線時選到具體分類', (text, topCategory, subcategory) => {
    expect(classifyLocally({ items: [text] })).toMatchObject({ topCategory, subcategory });
    expect(EXPENSE_TAXONOMY[topCategory]).toContain(subcategory);
  });

  it('品項優先於商家；GAS 與本機使用完全相同的分類表', () => {
    expect(classifyLocally({ merchant: '全聯', items: ['咖啡'] }).subcategory).toBe('咖啡');
    const source = readFileSync(new URL('../gas/invoice-proxy.gs', import.meta.url), 'utf8');
    const taxonomy = new Function(`${source}\nreturn { expense: EXPENSE_TAXONOMY, income: INCOME_TAXONOMY, capabilities: getLedgerCapabilities_() };`)();
    expect(taxonomy.expense).toEqual(EXPENSE_TAXONOMY);
    expect(taxonomy.income).toEqual(INCOME_TAXONOMY);
    expect(taxonomy.capabilities.categoryTaxonomyVersion).toBe(2);
  });
});

describe('下一次固定流水與還原衝突', () => {
  it('每日、每週和月底規則保留開始日期節奏，略過已建立紀錄與閏年月底', () => {
    const rule = { id: 'r', enabled: true, startDate: '2024-02-01', cadence: 'monthly', day: 31 };
    expect(nextRecurringDate(rule, '2024-02-20')).toBe('2024-02-29');
    expect(nextRecurringDate(rule, '2024-02-29', [{ source: 'recurring', sourceId: 'r:2024-02-29' }])).toBe('2024-03-31');
    expect(nextRecurringDate({ ...rule, cadence: 'weekly' }, '2024-02-20')).toBe('2024-02-22');
    expect(nextRecurringDate({ ...rule, cadence: 'daily' }, '2024-02-29', [{ source: 'recurring', sourceId: 'r:2024-02-29' }])).toBe('2024-03-01');
    expect(nextRecurringDate({ ...rule, enabled: false }, '2024-02-20')).toBeNull();
    // 即使使用者事後編輯固定流水產生的交易使 source 變成 manual，仍不會重複列出當日
    expect(nextRecurringDate(rule, '2024-02-29', [{ id: 'recurring:r:2024-02-29', source: 'manual' }])).toBe('2024-03-31');
  });

  it('還原預覽標出會被較舊備份覆蓋的本機交易 ID', () => {
    const current = createEmptyState();
    current.transactions = [{ id: 'a', type: 'expense', amount: 50, account: 'cash', category: '飲食', date: '2026-10-01', updatedAt: '2026-10-22T00:00:00Z' }];
    const incoming = { ...current, transactions: [{ ...current.transactions[0], amount: 30, updatedAt: '2026-10-01T00:00:00Z' }] };
    expect(previewBackupRestore(current, incoming).conflicts).toEqual(['a']);
    expect(previewBackupRestore(incoming, current).conflicts).toEqual([]);
  });
});

describe('跨期趨勢、累計步調與多期變化基準', () => {
  const sampleRows = [
    { id: 'm1-rent', type: 'expense', amount: 12000, category: '居家', subcategory: '房租', date: '2026-07-05' },
    { id: 'm1-food', type: 'expense', amount: 3000, category: '飲食', subcategory: '午餐', date: '2026-07-15' },
    { id: 'm1-late', type: 'expense', amount: 2000, category: '飲食', subcategory: '晚餐', date: '2026-07-28' },
    { id: 'm2-rent', type: 'expense', amount: 12000, category: '居家', subcategory: '房租', date: '2026-08-05' },
    { id: 'm2-food', type: 'expense', amount: 3300, category: '飲食', subcategory: '午餐', date: '2026-08-15' },
    { id: 'm2-late', type: 'expense', amount: 2100, category: '飲食', subcategory: '晚餐', date: '2026-08-28' },
    { id: 'm3-rent', type: 'expense', amount: 12000, category: '居家', subcategory: '房租', date: '2026-09-05' },
    { id: 'm3-food', type: 'expense', amount: 3600, category: '飲食', subcategory: '午餐', date: '2026-09-15' },
    { id: 'm3-late', type: 'expense', amount: 1800, category: '飲食', subcategory: '晚餐', date: '2026-09-28' },
    { id: 'm4-rent', type: 'expense', amount: 12000, category: '居家', subcategory: '房租', date: '2026-10-05' },
    { id: 'm4-food', type: 'expense', amount: 4200, category: '飲食', subcategory: '午餐', date: '2026-10-15' },
    { id: 'm4-inc', type: 'income', amount: 45000, category: '薪資', subcategory: '固定薪資', date: '2026-10-05' },
  ];

  it('跨期趨勢裁去開帳前空白月份，且平均只計算已結束的完整期間', () => {
    const trend = buildTrendSeries(sampleRows, {
      period: 'month',
      range: { from: '2026-10-01', to: '2026-10-31' },
      currentDate: '2026-10-20',
    });
    expect(trend.rows.map(row => row.key)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(trend.rows.at(-1).partial).toBe(true);
    expect(trend.average.count).toBe(3);
    // (17000 + 17400 + 17400) / 3 = 17267
    expect(trend.average.expense).toBe(17267);
  });

  it('累計步調以歷史剩餘天數外推期末金額，避免把月初房租線性放大', () => {
    const pace = buildPace(sampleRows, {
      period: 'month',
      range: { from: '2026-10-01', to: '2026-10-31' },
      currentDate: '2026-10-20',
      type: 'expense',
    });
    expect(pace.elapsed).toBe(20);
    expect(pace.currentTotal).toBe(16200);
    // 前三個月 20 日後的剩餘支出平均約 (2000 + 2100 + 1800) / 3 = 1967，不會把 12000 房租再乘一次
    expect(pace.projected).toBe(16200 + 1967);
    expect(pace.projectionMethod).toBe('history');
    expect(pace.rows[19].current).toBe(16200);
    expect(pace.rows[20].current).toBeNull();
  });

  it('分類異動對照前 3 期同期平均，並支援在總覽與分類頁切換步調圖', () => {
    const movers = buildCategoryMovers(sampleRows, {
      period: 'month',
      range: { from: '2026-10-01', to: '2026-10-31' },
      currentDate: '2026-10-20',
    });
    expect(movers.baselineCount).toBe(3);
    expect(movers.rows[0]).toMatchObject({ category: '飲食', amount: 4200, baseline: 3300, change: 900 });

    const state = createEmptyState();
    state.transactions = sampleRows;
    state.budgets = [{ category: '飲食', limit: 6000 }];
    const paceHtml = renderInsights(state, '2026-10', {
      insightFilters: { period: 'month', section: 'expense', category: '飲食', chartMode: 'pace', anchorDate: '2026-10-20' },
    });
    expect(paceHtml).toContain('workbench-pace-chart');
    expect(paceHtml).toContain('預算上限');
    expect(paceHtml).toContain('前 3 期平均步調');
  });
});
