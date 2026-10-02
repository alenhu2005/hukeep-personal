import { expect, test } from '@playwright/test';
import { createTransaction } from '../../src/domain/transactions.js';
import { createEmptyState, STORAGE_KEY } from '../../src/storage/ledger-repository.js';

const FIXED_NOW = '2026-10-02T04:00:00.000Z';

function transaction(id, overrides = {}) {
  return createTransaction({
    type: 'expense', amount: 100, category: '飲食', subcategory: '午餐',
    account: 'cash', date: '2026-10-01', name: id, note: '', ...overrides,
  }, { id, now: FIXED_NOW });
}

function stateWith(transactions = []) {
  return { ...createEmptyState(), transactions };
}

function analysisState() {
  const state = stateWith([
    transaction('food-current-coffee', { name: '本月咖啡', amount: 80, date: '2026-10-02', subcategory: '咖啡' }),
    transaction('food-current-drink', { name: '本月飲料', amount: 30, date: '2026-10-02', subcategory: '飲料' }),
    transaction('food-previous-coffee', { name: '前月咖啡', amount: 40, date: '2026-09-02', subcategory: '咖啡' }),
    transaction('food-previous-drink', { name: '前月飲料', amount: 25, date: '2026-09-02', subcategory: '飲料' }),
    transaction('other-current-expense', {
      name: '本日交通', amount: 900, date: '2026-10-02', category: '交通', subcategory: '大眾運輸',
    }),
    transaction('other-previous-expense', {
      name: '前日交通', amount: 700, date: '2026-09-02', category: '交通', subcategory: '大眾運輸',
    }),
    transaction('income-current', {
      type: 'income', name: '本月薪資', amount: 3000, date: '2026-10-02', category: '薪資', subcategory: '',
    }),
    transaction('income-previous', {
      type: 'income', name: '前月薪資', amount: 2800, date: '2026-09-02', category: '薪資', subcategory: '',
    }),
  ]);
  state.budgets = [{ category: '飲食', limit: 5000 }];
  return state;
}

async function openApp(page, state = createEmptyState()) {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript(({ key, value }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
    localStorage.removeItem('hukeep_device_binding_endpoint_v1');
    localStorage.removeItem('hukeep_device_binding_token_v1');
  }, { key: STORAGE_KEY, value: state });
  await page.route('https://**', route => route.abort());
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '總覽' })).toBeVisible();
}

test('未送出的手動交易在關閉及重新載入後可繼續編輯', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#manual-entry summary').click();
  await page.locator('#transaction-name').fill('草稿午餐');
  await page.locator('#transaction-amount').fill('320');
  await expect(page.locator('#discard-entry-draft')).toBeVisible();

  await page.locator('#transaction-dialog .dialog-close').click();
  await page.reload();
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await expect.poll(() => page.locator('#manual-entry').evaluate(element => element.open)).toBe(true);
  await expect(page.locator('#transaction-name')).toHaveValue('草稿午餐');
  await expect(page.locator('#transaction-amount')).toHaveValue('320');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions.length, STORAGE_KEY)).toBe(0);

  await page.locator('#discard-entry-draft').click();
  await expect(page.locator('#transaction-name')).toHaveValue('');
  await expect(page.locator('#transaction-amount')).toHaveValue('');
  await expect(page.locator('#discard-entry-draft')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('hukeep_personal_entry_draft_v1'))).toBeNull();
});

test('手動表單可儲存範本，重新載入後套用範本', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#manual-entry summary').click();
  await page.locator('#transaction-name').fill('範本咖啡');
  await page.locator('#transaction-amount').fill('85');
  await page.locator('#save-entry-template').click();
  await expect.poll(() => page.evaluate(key =>
    JSON.parse(localStorage.getItem(key)).featureSettings.templates.length, STORAGE_KEY)).toBe(1);

  await page.locator('#transaction-dialog .dialog-close').click();
  await page.reload();
  await page.getByRole('button', { name: '快速記一筆' }).click();
  const template = page.locator('#entry-templates [data-entry-template]');
  await expect(template).toHaveCount(1);
  await template.click();
  const manualEntry = page.locator('#manual-entry');
  if (!(await manualEntry.evaluate(element => element.open))) await manualEntry.locator('summary').click();
  await expect(page.locator('#transaction-name')).toHaveValue('範本咖啡');
  await expect(page.locator('#transaction-amount')).toHaveValue('85');
});

test('勾選分類記憶後，同名手動交易沿用大分類與小分類', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#manual-entry summary').click();
  await page.locator('#transaction-name').fill('指定分類店家');
  await page.locator('#transaction-amount').fill('150');
  await expect(page.locator('#transaction-category')).toBeVisible();
  await page.locator('#remember-category-rule').check();
  await page.locator('#transaction-category').selectOption('居家');
  await page.locator('#transaction-subcategory').selectOption('清潔用品');
  await page.locator('#transaction-form button[type="submit"]').click();
  await expect(page.locator('#transaction-dialog')).not.toBeVisible();

  const savedRules = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).featureSettings.categoryRules, STORAGE_KEY);
  expect(savedRules).toContainEqual(expect.objectContaining({
    match: '指定分類店家', category: '居家', subcategory: '清潔用品',
  }));

  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#manual-entry summary').click();
  await page.locator('#transaction-name').fill('指定分類店家');
  await page.locator('#transaction-amount').fill('150');
  await expect(page.locator('#transaction-category')).toBeVisible();
  await expect(page.locator('#transaction-category')).toHaveValue('居家');
  await expect(page.locator('#transaction-subcategory')).toHaveValue('清潔用品');
});

test('離線刪除可復原相同交易 ID 與內容', async ({ page }) => {
  const entry = transaction('undo-this-entry', { name: '可復原午餐', amount: 240 });
  await openApp(page, stateWith([entry]));
  await page.getByRole('button', { name: '紀錄', exact: true }).click();

  const confirmation = page.waitForEvent('dialog');
  const deleteClick = page.locator('[data-transaction-row]').filter({ hasText: '可復原午餐' })
    .locator('[data-delete-id]').click();
  const dialog = await confirmation;
  expect(dialog.message()).toContain('可復原午餐');
  await dialog.accept();
  await deleteClick;

  await expect(page.locator('#toast')).toBeVisible();
  const deleted = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(deleted).toEqual([]);
  await page.locator('#toast-action').click();
  const restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ id: entry.id, name: entry.name, amount: entry.amount, date: entry.date });
});

test('歷史可一次更新多筆交易的分類、小分類與帳戶', async ({ page }) => {
  const entries = [
    transaction('bulk-one', { name: '批次午餐一', amount: 110 }),
    transaction('bulk-two', { name: '批次午餐二', amount: 125, date: '2026-10-02' }),
  ];
  await openApp(page, stateWith(entries));
  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.locator('[data-bulk-toggle]').click();
  for (const name of ['批次午餐一', '批次午餐二']) {
    await page.locator('[data-transaction-row]').filter({ hasText: name })
      .locator('[data-select-transaction]').check();
  }
  await page.locator('[data-bulk-edit]').click();

  const form = page.locator('#bulk-edit-form');
  await form.locator('[name="category"]').selectOption('居家');
  await form.locator('[name="subcategory"]').selectOption('清潔用品');
  await form.locator('[name="account"]').selectOption('line');
  await form.locator('button[type="submit"]').click();

  const updated = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(updated).toHaveLength(2);
  expect(updated.map(({ id, category, subcategory, account }) => ({ id, category, subcategory, account })))
    .toEqual(entries.map(({ id }) => ({ id, category: '居家', subcategory: '清潔用品', account: 'line' })));
  await expect(page.locator('#workspace-dialog')).not.toBeVisible();
});

test('連結退款後收入不重複計入，明細與帳戶餘額呈現退款淨額', async ({ page }) => {
  const state = stateWith([
    transaction('original-expense', { name: '原本餐費', amount: 200, date: '2026-10-01' }),
    transaction('refund-income', {
      type: 'income', name: '餐費退款', amount: 50, category: '退款與理賠', subcategory: '', date: '2026-10-02',
    }),
  ]);
  await openApp(page, state);
  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.locator('[data-detail-id="refund-income"]').click();
  const refundForm = page.locator('#transaction-detail-dialog #refund-link-form');
  await refundForm.locator('[name="originalId"]').selectOption('original-expense');
  await refundForm.locator('button[type="submit"]').click();
  await expect(refundForm.locator('[name="originalId"]')).toHaveValue('original-expense');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions
    .find(item => item.id === 'refund-income').refundOf, STORAGE_KEY)).toBe('original-expense');

  await page.locator('#transaction-detail-dialog .dialog-close').click();
  await page.getByRole('button', { name: '總覽', exact: true }).click();
  await expect(page.getByTestId('summary-income')).toHaveText('NT$ 0');
  await expect(page.getByTestId('summary-expense')).toHaveText('NT$ 150');
  await expect(page.locator('[data-account-history="cash"]')).toContainText('-NT$ 150');

  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.locator('[data-detail-id="original-expense"]').click();
  await expect(page.locator('#transaction-detail-content')).toContainText(
    '原消費 NT$ 200 · 已退款 NT$ 50 · 淨支出 NT$ 150',
  );
});

test('帳戶卡片開啟對帳後流水，待上傳檢視器顯示新交易名稱與 ID', async ({ page }) => {
  const state = stateWith([
    transaction('checkpoint-before', { name: '對帳前消費', amount: 100, date: '2026-09-30' }),
    transaction('checkpoint-after', { name: '對帳後消費', amount: 50, date: '2026-10-02' }),
  ]);
  state.accounts.find(account => account.id === 'cash').openingBalance = 1000;
  state.featureSettings.reconciliations.push({
    id: 'cash-checkpoint', accountId: 'cash', estimatedBalance: 900, actualBalance: 900,
    date: '2026-10-01', createdAt: '2026-10-01T04:00:00.000Z',
  });
  await openApp(page, state);

  await page.locator('[data-account-history="cash"]').click();
  const workspace = page.locator('#workspace-dialog');
  const history = workspace.locator('#workspace-dialog-content');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('#workspace-dialog-title')).toHaveText('帳戶與對帳紀錄');
  await expect(history).toContainText('10/1 對帳');
  await expect(history).toContainText('對帳後淨流動 -NT$ 50');
  await expect(history.locator('[data-detail-id="checkpoint-after"]')).toContainText('對帳後消費');
  await history.locator('[data-detail-id="checkpoint-after"]').click();
  await expect(page.locator('#transaction-detail-dialog')).toBeVisible();
  await page.locator('#transaction-detail-dialog .dialog-close').click();
  await expect(workspace).toBeVisible();
  await workspace.locator('.dialog-close').click();

  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#manual-entry summary').click();
  await page.locator('#transaction-name').fill('待上傳的午餐');
  await page.locator('#transaction-amount').fill('180');
  await expect(page.locator('#transaction-category')).toBeVisible();
  await page.locator('#transaction-form button[type="submit"]').click();
  const entryId = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions
    .find(item => item.name === '待上傳的午餐').id, STORAGE_KEY);

  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.locator('#tools-dialog #inspect-pending-sync').click();
  const inspector = page.locator('#workspace-dialog');
  await expect(inspector).toBeVisible();
  await expect(inspector.locator('#workspace-dialog-title')).toHaveText('待上傳項目');
  const pendingEntry = inspector.locator('.sync-inspector-item[data-kind="transaction"]')
    .filter({ hasText: entryId });
  await expect(pendingEntry).toContainText('待上傳的午餐');
  await expect(pendingEntry).toContainText(entryId);
});

test('本期與前期的圖表鑽取只顯示所選日期、類型與分類，關閉後保留篩選與捲動位置', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page, analysisState());
  await page.getByRole('button', { name: '趨勢', exact: true }).click();
  await page.locator('[data-insight-section="expense"]').click();
  await page.locator('[data-insight-category="飲食"]').click();
  await expect(page.locator('[data-insight-compare-subcategory]')).toHaveCount(2);
  await page.locator('[data-analysis-disclosure="expense-budget-history"] > summary').click();
  await expect(page.locator('.analysis-upgrade-budget-chart')).toBeVisible();
  await page.locator('[data-analysis-disclosure="expense-飲食-multi"] > summary').click();
  for (const value of ['咖啡', '飲料']) {
    await page.locator(`[data-insight-compare-subcategory="${value}"]`).click();
  }
  await expect(page.locator('[data-insight-compare-subcategory][aria-pressed="true"]')).toHaveCount(2);
  await expect(page.locator('[data-analysis-disclosure="expense-飲食-multi"]')).toHaveAttribute('open');
  expect(await page.evaluate(() => document.activeElement.dataset.insightCompareSubcategory)).toBe('飲料');
  await expect(page.locator('.analysis-upgrade-compare-value')).not.toHaveCount(0);
  await page.locator('[data-analysis-disclosure="expense-飲食--comparison"] > summary').click();

  for (const [selector, expectedIds] of [
    ['.analysis-upgrade-value.current[data-date="2026-10-02"]', ['food-current-coffee', 'food-current-drink']],
    ['.analysis-upgrade-value.previous[data-date="2026-09-02"]', ['food-previous-coffee', 'food-previous-drink']],
  ]) {
    const chart = page.locator(selector);
    await expect(chart).toHaveCount(1);
    await chart.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scrollY = await page.evaluate(() => window.scrollY);
    await chart.click();
    const workspace = page.locator('#workspace-dialog');
    await expect(workspace).toBeVisible();
    const returnScroll = Number(await workspace.getAttribute('data-return-scroll'));
    expect(returnScroll).toBe(scrollY);
    const ids = await workspace.locator('#workspace-dialog-content [data-detail-id]')
      .evaluateAll(elements => elements.map(element => element.dataset.detailId));
    expect(new Set(ids)).toEqual(new Set(expectedIds));
    await workspace.locator('.dialog-close').click();
    await expect(workspace).not.toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(returnScroll);
    await expect(page.locator('[data-insight-section="expense"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-insight-category="飲食"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-insight-compare-subcategory="咖啡"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-insight-compare-subcategory="飲料"]')).toHaveAttribute('aria-pressed', 'true');
  }
});

test('360px 深色與減少動態偏好下的分析頁沒有水平溢出', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await openApp(page, analysisState());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '趨勢', exact: true }).click();
  await page.locator('[data-insight-section="expense"]').click();
  await page.locator('[data-insight-category="飲食"]').click();
  await expect(page.locator('[data-insight-compare-subcategory]')).toHaveCount(2);
  await page.locator('[data-analysis-disclosure="expense-飲食-multi"] > summary').click();
  await page.locator('[data-insight-compare-subcategory="咖啡"]').click();
  await page.locator('[data-insight-compare-subcategory="飲料"]').click();
  await expect(page.locator('.analysis-upgrade-compare-value')).not.toHaveCount(0);
  await page.locator('.analysis-upgrade-compare-value').first().scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/expense-compare-360.png', fullPage: true });
});
