import { expect, test } from '@playwright/test';
import { serializeBackup } from '../../src/backup.js';
import { createTransaction } from '../../src/domain/transactions.js';
import { createEmptyState, STORAGE_KEY } from '../../src/storage/ledger-repository.js';

const FIXED_NOW = '2026-09-30T04:00:00.000Z';

function transaction(id, overrides = {}) {
  return createTransaction({
    type: 'expense', amount: 100, category: '飲食', subcategory: '早餐',
    account: 'cash', date: '2026-09-05', name: id, note: '', ...overrides,
  }, { id, now: FIXED_NOW });
}

function stateWith(transactions = []) {
  return { ...createEmptyState(), transactions };
}

async function openApp(page, state = createEmptyState()) {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.addInitScript(({ key, value }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: state });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '總覽' })).toBeVisible();
}

test('同步佇列無法寫入時不誤報成功，也不留下會被拉取覆蓋的新交易', async ({ page }) => {
  await openApp(page);
  const before = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'hukeep_pending_sheet_changes_v1') throw new DOMException('fixture quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByLabel('口語記帳內容').fill('午餐 100 元用現金支付');
  await page.getByRole('button', { name: '直接記帳' }).click();
  await expect(page.locator('#toast')).toContainText('無法儲存');
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(before);
});

test('帳本寫入失敗時回復同步佇列，不留下不存在的待上傳交易', async ({ page }) => {
  await openApp(page);
  const journalKey = 'hukeep_pending_sheet_changes_v1';
  const before = await page.evaluate(key => localStorage.getItem(key), journalKey);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('fixture quota', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, STORAGE_KEY);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByLabel('口語記帳內容').fill('午餐 100 元用現金支付');
  await page.getByRole('button', { name: '直接記帳' }).click();
  await expect(page.locator('#toast')).toContainText('無法儲存');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), journalKey)).toEqual(JSON.parse(before));
});

test('過期分頁新增交易不覆寫另一分頁剛保存的交易', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.clock.setFixedTime(new Date(FIXED_NOW));
  await second.addInitScript(() => window.addEventListener('storage', event => event.stopImmediatePropagation()));
  await second.goto('./');
  for (const [tab, text] of [[page, '午餐 100 元用現金支付'], [second, '晚餐 150 元用 LINE 支付']]) {
    await tab.getByRole('button', { name: '快速記一筆' }).click();
    await tab.getByLabel('口語記帳內容').fill(text);
    await tab.getByRole('button', { name: '直接記帳' }).click();
    await expect(tab.locator('#transaction-dialog')).not.toBeVisible();
  }
  const saved = await second.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(saved.map(item => item.amount).sort((a, b) => a - b)).toEqual([100, 150]);
  await second.close();
});

test('多品項口語遇到不明帳戶時先預覽，逐筆確認後才記帳', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByLabel('口語記帳內容').fill('早餐豆漿 40 元、飯糰 35 元');
  await page.getByRole('button', { name: '直接記帳' }).click();

  const review = page.locator('#voice-review');
  await expect(review).toBeVisible();
  await expect(review.locator('.voice-review-item')).toHaveCount(2);
  await expect(review.locator('[data-review-amount="0"]')).toHaveValue('40');
  await expect(review.locator('[data-review-amount="1"]')).toHaveValue('35');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions.length, STORAGE_KEY)).toBe(0);
  await review.locator('[data-review-account="0"]').selectOption('cash');
  await review.locator('[data-review-account="1"]').selectOption('line');
  await review.getByRole('button', { name: '確認 2 筆' }).click();

  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(saved).toHaveLength(2);
  expect(saved.map(item => item.amount).sort((a, b) => a - b)).toEqual([35, 40]);
  expect(new Set(saved.map(item => item.account))).toEqual(new Set(['cash', 'line']));
});

test('依對帳日計算差額，建立調整後生活支出總額不變', async ({ page }) => {
  const state = stateWith([
    transaction('before-reconciliation', { type: 'income', amount: 3000, category: '薪資', date: '2026-09-05' }),
    transaction('living-before', { amount: 300, date: '2026-09-08' }),
    transaction('living-after', { amount: 200, date: '2026-09-20' }),
  ]);
  state.accounts = state.accounts.map(account => account.id === 'cash'
    ? { ...account, openingBalance: 5000 }
    : account);
  await openApp(page, state);
  const expenseBefore = await page.getByTestId('summary-expense').innerText();
  await page.getByRole('button', { name: '備份與設定' }).click();
  const tools = page.locator('#tools-dialog');
  const form = tools.locator('#reconciliation-form');
  await form.locator('[name="accountId"]').selectOption('cash');
  await form.locator('[name="actualBalance"]').fill('7800');
  await form.locator('[name="date"]').fill('2026-09-10');
  await form.getByRole('button', { name: '儲存對帳結果' }).click();
  await expect(tools.locator('#reconciliation-list')).toContainText(/帳本.*7,700.*實際.*7,800.*差額.*100/);

  const confirmation = page.waitForEvent('dialog');
  const adjustmentClick = tools.getByRole('button', { name: '建立差額調整' }).click();
  const dialog = await confirmation;
  expect(dialog.message()).toContain('不計入生活收支');
  await dialog.accept();
  await adjustmentClick;
  await tools.locator('.dialog-close').click();

  await expect(page.getByTestId('summary-expense')).toHaveText(expenseBefore);
  await expect(page.locator('.account-item').filter({ hasText: '現金' })).toContainText('已對帳');
  await expect(page.locator('.account-item').filter({ hasText: '現金' })).toContainText('已調整');
  const adjustments = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions
    .filter(item => item.category === '帳務調整'), STORAGE_KEY);
  expect(adjustments).toHaveLength(1);
  expect(adjustments[0]).toMatchObject({ type: 'income', amount: 100, date: '2026-09-10' });
});

test('投資市值取代投資本金計入總資產，重新載入仍只計一次', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('total-assets')).toContainText('12,891');
  await page.getByRole('button', { name: '備份與設定' }).click();
  const form = page.locator('#tools-dialog #reconciliation-form');
  await form.locator('[name="accountId"]').selectOption('investment');
  await form.locator('[name="actualBalance"]').fill('15000');
  await form.locator('[name="date"]').fill('2026-09-30');
  await form.getByRole('button', { name: '儲存對帳結果' }).click();
  await page.locator('#tools-dialog .dialog-close').click();
  await expect(page.getByTestId('total-assets')).toHaveText('NT$ 15,000');
  await page.reload();
  await expect(page.getByTestId('total-assets')).toHaveText('NT$ 15,000');
  await expect(page.locator('.account-item').filter({ hasText: '投資資產' })).toContainText('NT$ 15,000');
});

test('長 ID 的對帳調整只建立一次，補登歷史交易後可更新同一筆調整', async ({ page }) => {
  const state = stateWith([]);
  state.accounts = state.accounts.map(account => account.id === 'cash' ? { ...account, openingBalance: 80 } : account);
  state.featureSettings.reconciliations = [{ id: 'a'.repeat(80), accountId: 'cash', actualBalance: 70,
    estimatedBalance: 80, date: '2026-09-10', createdAt: FIXED_NOW }];
  await openApp(page, state);
  await page.getByRole('button', { name: '備份與設定' }).click();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '建立差額調整' }).click();
  await expect(page.getByRole('button', { name: '已調整', exact: true })).toBeDisabled();
  const first = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions
    .filter(item => item.category === '帳務調整'), STORAGE_KEY);
  expect(first).toHaveLength(1);
  expect(first[0].id.length).toBeLessThanOrEqual(80);
  await page.locator('#tools-dialog .dialog-close').click();
  await page.evaluate(({ key, entry }) => {
    const current = JSON.parse(localStorage.getItem(key));
    current.transactions.push(entry);
    localStorage.setItem(key, JSON.stringify(current));
  }, { key: STORAGE_KEY, entry: transaction('backdated-income', { type: 'income', amount: 20,
    category: '薪資', date: '2026-09-01' }) });
  await page.reload();
  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.getByRole('button', { name: '更新差額調整' }).click();
  await expect(page.getByRole('button', { name: '已調整', exact: true })).toBeDisabled();
  const updated = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions
    .filter(item => item.category === '帳務調整'), STORAGE_KEY);
  expect(updated).toHaveLength(1);
  expect(updated[0]).toMatchObject({ id: first[0].id, type: 'expense', amount: 30 });
});

test('歷史可搜尋全部月份，固定流水可編輯並暫停', async ({ page }) => {
  const state = stateWith([
    transaction('august-entry', { date: '2026-08-15', name: '跨月咖啡紀錄' }),
    transaction('september-entry', { date: '2026-09-15', name: '跨月午餐紀錄' }),
  ]);
  state.featureSettings.recurringRules = [{
    id: 'rule-cloud', name: '雲端訂閱', type: 'expense', amount: 500,
    category: '帳單', account: 'cash', cadence: 'monthly', day: 12,
    startDate: '2026-10-01', enabled: true, createdAt: FIXED_NOW,
  }];
  await openApp(page, state);
  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await expect(page.locator('[data-transaction-row]')).toHaveCount(1);
  await page.locator('[data-history-month-scope="all"]').click();
  await page.getByLabel('搜尋紀錄').fill('跨月');
  await expect(page.locator('[data-transaction-row]')).toHaveCount(2);

  await page.getByRole('button', { name: '備份與設定' }).click();
  const tools = page.locator('#tools-dialog');
  await tools.locator('#recurring-rule-list article').filter({ hasText: '雲端訂閱' })
    .getByRole('button', { name: '編輯' }).click();
  const form = tools.locator('#recurring-rule-form');
  await form.locator('[name="name"]').fill('雲端訂閱 Plus');
  await form.locator('[name="amount"]').fill('650');
  await form.getByRole('button', { name: '儲存修改' }).click();
  const rule = tools.locator('#recurring-rule-list article').filter({ hasText: '雲端訂閱 Plus' });
  await expect(rule).toContainText('650');
  await rule.getByRole('button', { name: '暫停' }).click();
  await expect(rule).toContainText('暫停');

  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).featureSettings.recurringRules[0], STORAGE_KEY);
  expect(saved).toMatchObject({ name: '雲端訂閱 Plus', amount: 650, enabled: false });
});


test('備份還原先顯示新增與修改筆數，再由本機確認還原', async ({ page }) => {
  const current = stateWith([transaction('shared-entry', { name: '目前紀錄', amount: 100 })]);
  const backup = {
    ...current,
    transactions: [
      { ...current.transactions[0], name: '備份內更新紀錄', amount: 120 },
      transaction('backup-entry', { name: '備份新增紀錄', amount: 250, date: '2026-09-12' }),
    ],
  };
  await openApp(page, current);
  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.locator('#import-json').setInputFiles({
    name: 'backup.json', mimeType: 'application/json',
    buffer: Buffer.from(serializeBackup(backup), 'utf8'),
  });
  const preview = page.locator('#backup-preview-dialog');
  await expect(preview).toBeVisible();
  await expect(preview.locator('#backup-preview-content')).toContainText('交易新增 1 · 修改 1 · 移除 0');
  await expect(preview.locator('#backup-preview-confirm')).toBeEnabled();

  const download = page.waitForEvent('download');
  await preview.locator('#backup-preview-confirm').click();
  expect((await download).suggestedFilename()).toContain('hukeep-personal-before-import-2026-09-30.json');
  const restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions, STORAGE_KEY);
  expect(restored.map(item => item.id)).toEqual(['shared-entry', 'backup-entry']);
  expect(restored.find(item => item.id === 'shared-entry')).toMatchObject({ name: '備份內更新紀錄', amount: 120 });
});

test('360px 手機上的新設定與口語預覽不造成橫向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openApp(page);
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByLabel('口語記帳內容').fill('豆漿 40 元、飯糰 35 元');
  await page.getByRole('button', { name: '直接記帳' }).click();
  await expect(page.locator('#voice-review')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#transaction-dialog .dialog-close').click();
  await page.getByRole('button', { name: '備份與設定' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
