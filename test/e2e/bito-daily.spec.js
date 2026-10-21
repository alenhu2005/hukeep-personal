import { expect, test } from '@playwright/test';
import { createEmptyState } from '../../src/storage/ledger-repository.js';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-21T04:00:00Z'));
});

test('投資卡片展開兩帳戶、更新 Bito 市值並查看資產走勢，手機無橫滑', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = createEmptyState();
  state.preferences.theme = 'dark';
  state.accounts.find(account => account.id === 'sinopac').openingBalance = 10000;
  state.featureSettings.reconciliations = [
    { id: 's1', accountId: 'investment', actualBalance: 14000, date: '2026-10-01' },
    { id: 's2', accountId: 'investment', actualBalance: 15000, date: '2026-10-20' },
    { id: 'b1', accountId: 'bito', actualBalance: 2000, date: '2026-10-01' },
  ];
  await page.addInitScript(state => {
    if (!localStorage.getItem('hukeep_personal_state_v1')) localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state));
  }, state);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByTestId('total-assets')).toContainText('27,000');
  await expect(page.getByTestId('liquid-assets')).toContainText('10,000');
  await page.locator('[data-open-investments]').click();
  await expect(page.locator('.investment-accounts')).toContainText('股票與其他證券');
  await expect(page.locator('.investment-accounts')).toContainText('虛擬貨幣 · Bito');
  await page.locator('.investment-accounts [data-open-investment-valuation="bito"]').click();
  const form = page.locator('#reconciliation-form');
  await expect(form.locator('[name="accountId"]')).toHaveValue('bito');
  await form.getByLabel('實際餘額').fill('2500');
  await form.getByRole('button', { name: '儲存對帳結果' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('Bito');
  await expect(page.locator('#reconciliation-list [data-adjust-reconciliation]')).toHaveCount(0);
  await page.locator('#tools-dialog .dialog-close').click();
  await page.reload();
  await expect(page.getByTestId('total-assets')).toContainText('27,500');
  await page.locator('[data-open-investments]').click();
  await page.locator('[data-open-investment-analysis]').click();
  await expect(page).toHaveURL(/#insights$/);
  await expect(page.locator('.investment-asset-cards')).toContainText('2,500');
  await expect(page.locator('.investment-value-chart')).toBeVisible();
  await expect(page.locator('.investment-value-chart circle')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.investment-asset-analysis').screenshot({ path: 'test-results/bito-investment-mobile-dark.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('每日 Bito 定期記帳補登、不重複，隔日繼續且可暫停', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '備份與設定' }).click();
  const form = page.locator('#recurring-rule-form');
  await form.getByLabel('名稱', { exact: true }).fill('每日 Bito');
  await form.getByLabel('金額', { exact: true }).fill('100');
  await form.getByRole('combobox', { name: '類型', exact: true }).selectOption('transfer');
  await form.getByRole('combobox', { name: '週期', exact: true }).selectOption('daily');
  await expect(form.getByLabel('每月日期')).toBeHidden();
  await form.getByRole('combobox', { name: '帳戶', exact: true }).selectOption('sinopac');
  await form.getByRole('combobox', { name: '目的帳戶', exact: true }).selectOption('bito');
  await form.getByLabel('開始日期').fill('2026-10-19');
  await form.getByRole('button', { name: '新增固定流水' }).click();
  await expect(page.locator('#recurring-rule-list')).toContainText('每日');
  const entries = () => page.evaluate(() => JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions.filter(row => row.source === 'recurring'));
  expect(await entries()).toHaveLength(3);
  await page.reload();
  expect(await entries()).toHaveLength(3);
  await page.clock.setFixedTime(new Date('2026-10-22T04:00:00Z'));
  await page.reload();
  expect(await entries()).toHaveLength(4);
  expect((await entries()).every(row => row.category === '投資' && row.toAccount === 'bito')).toBe(true);
  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.locator('#recurring-rule-list [data-toggle-recurring]').click();
  await page.clock.setFixedTime(new Date('2026-10-23T04:00:00Z'));
  await page.reload();
  expect(await entries()).toHaveLength(4);
});

test('預算清單顯示本月至今日平均，未來交易不計入', async ({ page }) => {
  const state = createEmptyState();
  state.budgets = [{ category: '飲食', limit: 5000 }];
  state.transactions = [
    { id: 'today', type: 'expense', name: '午餐', category: '飲食', account: 'cash', amount: 420, date: '2026-10-01' },
    { id: 'future', type: 'expense', name: '預約', category: '飲食', account: 'cash', amount: 999, date: '2026-10-22' },
  ];
  await page.addInitScript(state => localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state)), state);
  await page.goto('./#budgets');
  await expect(page.locator('.budget-daily-average')).toHaveText('本月至今日平均 NT$ 20');
  await page.locator('.budget-list').screenshot({ path: 'test-results/budget-daily-average.png', animations: 'disabled' });
});
