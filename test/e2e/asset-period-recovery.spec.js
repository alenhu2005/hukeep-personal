import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createEmptyState, STORAGE_KEY } from '../../src/storage/ledger-repository.js';

test.use({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });

test('損毀帳本停在復原畫面，下載原文後仍保留本機資料', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '{broken'), STORAGE_KEY);
  await page.goto('./#overview');
  await expect(page.getByRole('heading', { name: '無法讀取本機帳本' })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載原始資料' }).click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toBe('{broken');
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('{broken');
});

test('回看上月時，資產明細和市值卡片都以所選期間為準', async ({ page }) => {
  const state = createEmptyState();
  state.budgets = [{ category: '飲食', limit: 10000 }];
  state.featureSettings.reconciliations = [
    { id: 'oct', accountId: 'investment', actualBalance: 12000, date: '2026-10-20', createdAt: '2026-10-20T03:00:00Z' },
    { id: 'nov', accountId: 'investment', actualBalance: 16000, date: '2026-11-02', createdAt: '2026-11-02T03:00:00Z' },
  ];
  await page.clock.setFixedTime(new Date('2026-11-04T04:00:00Z'));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: state });
  await page.goto('./#insights');
  await page.locator('[data-insight-shift="-1"]').click();
  const chart = page.getByRole('region', { name: '總資產變化', exact: true });
  await expect(chart.locator('.workbench-chart-readout')).toContainText('股票 NT$ 12,000');
  await page.locator('[data-insight-section="investment"]').click();
  await expect(page.locator('.investment-asset-card.securities b')).toHaveText('NT$ 12,000');
  await expect(page.locator('.workbench-chart-readout').first()).toContainText('依最近市值及其後交易估算');
  await page.locator('[href="#overview"]').first().click();
  await expect(page.locator('.budget-daily-limit')).toHaveText('本月已結束');
});

test('首次載入後立即離線重開仍可記帳', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    await page.goto('./#overview');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('#overview-title')).toBeVisible();
    await page.locator('#quick-add-button').click();
    const input = page.locator('#voice-transcript');
    await input.fill('晚餐100元現金');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(page.locator('#transaction-dialog')).toBeVisible();
    await page.locator('#voice-submit-button').click();
    await expect(page.locator('#transaction-dialog')).not.toBeVisible();
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).transactions.length, STORAGE_KEY)).toBe(1);
  } finally { await context.close(); }
});

test('紀錄搜尋保留中文選字及游標，從總覽看全部可解除舊條件', async ({ page }) => {
  await page.goto('./#history');
  const search = page.getByRole('searchbox', { name: '搜尋紀錄' });
  await search.fill('早餐');
  await search.evaluate(input => input.setSelectionRange(1, 1));
  await search.pressSequentially('A');
  expect(await search.evaluate(input => input.selectionStart)).toBe(2);
  await search.evaluate(input => {
    input.value = '尚在選字';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    if (!input.isConnected) throw new Error('搜尋欄在組字時被替換');
  });
  await page.locator('.brand').click();
  await page.getByRole('button', {name: '全部紀錄', exact: true}).click();
  await expect(search).toHaveValue('');
});
