import { expect, test } from '@playwright/test';
import { createEmptyState, STORAGE_KEY } from '../../src/storage/ledger-repository.js';
import { serializeBackup } from '../../src/backup.js';
test.use({ serviceWorkers: 'block' });

async function openFixture(page) {
  const state = createEmptyState();
  state.budgets = [{ category: '飲食', limit: 5000 }];
  state.transactions = [
    ...['飲料', '便當', '咖啡', '湯品'].map((subcategory, i) => ({ id: `food-${i}`, type: 'expense', category: '飲食', subcategory, account: 'cash', amount: 50 + i * 50, date: '2026-10-20', name: `${subcategory}測試`, createdAt: '2026-10-20T04:00:00Z' })),
    { id: 'salary', type: 'income', amount: 30000, category: '薪資', subcategory: '固定薪資', account: 'sinopac', date: '2026-10-02', name: '薪資' },
    { id: 'old', type: 'expense', amount: 80, category: '飲食', subcategory: '飲料', account: 'cash', date: '2026-09-20', name: '前期飲料' },
    { id: 'future', type: 'expense', amount: 300, category: '飲食', subcategory: '飲料', account: 'cash', date: '2026-10-25', name: '預約飲料' },
  ];
  await page.clock.setFixedTime(new Date('2026-10-22T04:00:00Z'));
  await page.setViewportSize({ width: 401, height: 850 });
  await page.addInitScript(({ state, key }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state)); }, { state, key: STORAGE_KEY });
  await page.goto('./#insights');
}

test('當日明細緊湊且獨立，分類與小分類主圖可選日期和核對前期', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFixture(page);
  await page.locator('[data-insight-date="2026-10-20"]').click();
  const day = page.locator('.analysis-history-section');
  await expect(day.locator('.transaction-row')).toHaveCount(4);
  await expect(day.locator('[data-edit-id], [data-delete-id]')).toHaveCount(0);
  expect(await day.locator('.transaction-row').first().evaluate(row => row.getBoundingClientRect().height)).toBeLessThanOrEqual(78);
  await day.screenshot({ path: 'test-results/workbench-compact-day.png' });
  await day.getByRole('button', { name: '關閉當日明細' }).click();
  await page.getByRole('button', { name: '支出分析', exact: true }).click();
  await page.locator('[data-insight-category="飲食"]').click();
  const children = page.getByRole('region', { name: '飲食小分類圖表', exact: true });
  await expect(children.locator('[data-insight-subcategory]')).toHaveCount(4);
  expect(await children.evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(await page.locator('.workbench-chart').evaluate(el => el.getBoundingClientRect().top));
  await children.locator('[data-insight-subcategory="飲料"]').click();
  await expect(page.locator('.analysis-focus h2')).toHaveText('飲料');
  await expect(page.locator('.analysis-focus .workbench-balance strong')).toHaveText('NT$ 50');
  await expect(page.locator('.analysis-focus .workbench-time-chart')).toHaveCount(1);
  await page.locator('[data-chart-point]').selectOption('19');
  await expect(page.locator('[data-chart-point] option:checked')).toHaveText('10/20');
  await expect(page.locator('.workbench-chart-readout')).toContainText('NT$ 50');
  await page.locator('.workbench-chart-readout button').click();
  await expect(page.locator('#workspace-dialog')).toContainText('飲料測試');
  await expect(page.locator('#workspace-dialog')).not.toContainText('預約飲料');
  await page.locator('#workspace-dialog .dialog-close').click();
  await page.getByRole('button', { name: '前期比較', exact: true }).click();
  await expect(page.locator('.workbench-chart-readout')).toContainText('前期');
  const before = await page.evaluate(() => scrollY);
  await page.getByRole('button', { name: '收入分析', exact: true }).click();
  await page.getByRole('button', { name: '支出分析', exact: true }).click();
  await expect(page.locator('.analysis-focus h2')).toHaveText('飲料');
  expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThan(100);
  await page.locator('.analysis-focus').screenshot({ path: 'test-results/workbench-subcategory.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('小分類比較最多三項，切換週期保留分類，無紀錄明示空狀態', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: '支出分析', exact: true }).click();
  await page.locator('[data-insight-category="飲食"]').click();
  await page.getByRole('button', { name: '比較小分類', exact: true }).click();
  const choices = page.locator('[data-insight-compare-subcategory]');
  for (const name of ['飲料', '便當', '咖啡', '湯品']) await page.locator(`[data-insight-compare-subcategory="${name}"]`).click();
  expect(await choices.evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-pressed') === 'true').length)).toBe(3);
  await expect(page.locator('.workbench-time-chart')).toHaveCount(1);
  await page.locator('[data-insight-period="week"]').click();
  await expect(page.locator('.analysis-focus h2')).toHaveText('飲食');
  await page.locator('[data-insight-shift="1"]').click();
  await page.locator('[data-insight-shift="1"]').click();
  await expect(page.locator('.workbench-empty')).toContainText('沒有符合的紀錄');
});

test('篩選可逐項清除，設定可查實際版本與新版提示', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.locator('.history-advanced-filters > summary').click();
  await page.locator('[data-history-filter="category"][data-history-value="飲食"]').click();
  await page.locator('[data-history-filter="subcategory"][data-history-value="飲料"]').click();
  await expect(page.locator('.history-active-filters')).toContainText('飲食');
  await page.getByRole('button', { name: '移除飲料篩選' }).click();
  await expect(page.locator('[data-history-filter="category"][data-history-value="飲食"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '清除篩選', exact: true }).click();
  await expect(page.locator('.history-active-filters')).toHaveCount(0);
  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(page.locator('#app-version')).toContainText('程式版本');
  await page.route('**/version.json*', route => route.fulfill({ json: { version: 'next-release' } }));
  await page.getByRole('button', { name: '檢查更新', exact: true }).click();
  await expect(page.locator('#app-update-status')).toContainText('新版 next-release');
  await expect(page.getByRole('button', { name: '重新載入新版' })).toBeVisible();
});

test('收支總覽緊湊，金額保持完整一行，舊小分類編輯不會被默默更換', async ({ page }) => {
  await openFixture(page);
  const panel = page.locator('.workbench-panel');
  const chart = panel.locator('.workbench-time-chart');
  expect(await chart.evaluate(el => el.getBoundingClientRect().top) - await panel.evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(270);
  expect(await panel.locator('.workbench-metrics dd').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 1.1))).toBe(true);
  await page.screenshot({ path: 'test-results/workbench-overview-compact.png', fullPage: true });
  await page.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key));
    state.transactions.find(row => row.name === '飲料測試').subcategory = '自訂舊分類';
    localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();
  await page.locator('[data-insight-date="2026-10-20"]').click();
  await page.getByRole('button', { name: '查看 飲料測試 詳情' }).click();
  await page.locator('#transaction-detail-dialog [data-edit-id]').click();
  await expect(page.locator('#transaction-subcategory')).toHaveValue('自訂舊分類');
});

test('還原預覽期間另一裝置更新帳本時，重算差異後才允許覆蓋', async ({ page }) => {
  await openFixture(page);
  const backup = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  backup.transactions[0].name = '備份版本';
  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.locator('#import-json').setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: Buffer.from(serializeBackup(backup)) });
  await expect(page.locator('#backup-preview-dialog')).toBeVisible();
  await page.evaluate(key => {
    const next = JSON.parse(localStorage.getItem(key));
    next.transactions.push({ id: 'another-device', type: 'expense', amount: 50, account: 'cash', category: '飲食', date: '2026-10-22', name: '另一裝置新增', createdAt: '2026-10-22T04:01:00Z', updatedAt: '2026-10-22T04:01:00Z' });
    const newValue = JSON.stringify(next);
    localStorage.setItem(key, newValue);
    dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }));
  }, STORAGE_KEY);
  await page.locator('#backup-preview-confirm').click();
  await expect(page.locator('#backup-preview-content')).toContainText('預覽期間帳本有更新');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions.some(row => row.id === 'another-device'), STORAGE_KEY)).toBe(true);
  const download = page.waitForEvent('download');
  await page.locator('#backup-preview-confirm').click();
  expect((await download).suggestedFilename()).toContain('before-import');
});
