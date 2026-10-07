import { expect, test } from '@playwright/test';
import { createEmptyState } from '../../src/storage/ledger-repository.js';
import { createMonthlySnapshot } from '../../src/domain/ledger-enhancements.js';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-29T04:00:00Z'));
});

test('對帳儲存後立即顯示，重新整理仍保留', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.getByRole('button', { name: '備份與設定' }).click();
  expect(errors).toEqual([]);
  await expect(page.locator('#tools-dialog')).toBeVisible();
  const form = page.locator('#reconciliation-form');
  await form.locator('select[name="accountId"]').selectOption('cash');
  await form.getByLabel('實際餘額').fill('0');
  await form.getByLabel('對帳日期').fill('2026-09-29');
  await form.getByRole('button', { name: '儲存對帳結果' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('現金 · 2026-09-29');
  await page.reload();
  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('現金 · 2026-09-29');
  await expect(page.locator('#reconciliation-list')).not.toContainText('尚未儲存');
});

for (const actualBalance of [1000, 990]) {
  test(`同日對帳 ${actualBalance} 後新記帳只更新餘額，不再顯示新差額`, async ({ page }) => {
    await page.setViewportSize({ width: 401, height: 784 });
    const state = createEmptyState();
    state.accounts.find(account => account.id === 'cash').openingBalance = 1000;
    await page.addInitScript(state => {
      const key = 'hukeep_personal_state_v1';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
    }, state);
    await page.goto('./');
    await page.getByRole('button', { name: '備份與設定' }).click();
    const form = page.locator('#reconciliation-form');
    await form.locator('select[name="accountId"]').selectOption('cash');
    await form.getByLabel('實際餘額').fill(String(actualBalance));
    await form.getByRole('button', { name: '儲存對帳結果' }).click();
    if (actualBalance !== 1000) {
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '建立差額調整' }).click();
      await expect(page.getByRole('button', { name: '已調整', exact: true })).toBeDisabled();
    }
    await page.locator('#tools-dialog .dialog-close').click();
    await page.clock.setFixedTime(new Date('2026-09-29T04:01:00.000Z'));
    await page.getByRole('button', { name: '快速記一筆' }).click();
    await page.getByLabel('口語記帳內容').fill('午餐 100 元用現金支付');
    await page.getByRole('button', { name: '直接記帳' }).click();
    await expect(page.locator('#transaction-dialog')).not.toBeVisible();
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      const cash = page.locator('.account-item').filter({ hasText: '現金' });
      await expect(cash).toContainText(`NT$ ${actualBalance - 100}`);
      await expect(cash).toContainText('已對帳 · 9/29');
      await expect(cash).not.toContainText('差 NT$');
      await expect(cash).not.toContainText('待重新調整');
      await expect(cash.locator('.mismatch')).toHaveCount(0);
      if (actualBalance !== 1000) await expect(cash).toContainText('已調整');
    }
    await page.getByRole('button', { name: '備份與設定' }).click();
    await expect(page.locator('#reconciliation-list')).toContainText('帳本 NT$ 1,000');
    await expect(page.getByRole('button', { name: '更新差額調整' })).toHaveCount(0);
    if (actualBalance === 1000) {
      await expect(page.locator('#reconciliation-list')).toContainText('一致');
      await expect(page.getByRole('button', { name: '建立差額調整' })).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: '已調整', exact: true })).toBeDisabled();
    }
  });
}

test('讀回另一裝置的對帳結果時，已開啟的設定立即更新', async ({ page }) => {
  await page.setViewportSize({ width: 401, height: 784 });
  const remote = createEmptyState();
  remote.featureSettings.monthlySnapshots = [createMonthlySnapshot(remote, '2026-08')];
  await page.route('https://proxy.example/reconciliation', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'syncLedgerChanges') {
      if (body.changes.featureSettings) remote.featureSettings = body.changes.featureSettings;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { accountCount: 6, transactionCount: 0, budgetCount: 0, featureSettingsVersion: 1 } }),
      });
      return;
    }
    expect(body.action).toBe('loadLedgerState');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: remote }),
    });
  });
  await page.goto('./');
  await page.evaluate(state => {
    localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state));
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://proxy.example/reconciliation');
    localStorage.setItem('hukeep_device_binding_token_v1', 'test-only-token');
  }, remote);
  await page.reload();
  await expect(page.locator('#sync-indicator')).toContainText('已同步');
  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('尚未儲存');
  remote.featureSettings.reconciliations = [{
    id: 'remote-reconciliation', accountId: 'cash', actualBalance: 0,
    date: '2026-09-29', createdAt: '2026-09-29T03:00:00.000Z',
  }];
  const form = page.locator('#reconciliation-form');
  await form.getByLabel('實際餘額').fill('777');
  await form.getByLabel('備註').fill('尚未送出的輸入');
  await page.getByRole('button', { name: '同步到 Google Sheet' }).click();
  await expect(page.locator('#sheet-sync-status')).toContainText('同步完成');
  await expect(page.locator('#reconciliation-list')).toContainText('現金 · 2026-09-29');
  await expect(page.locator('#reconciliation-list')).not.toContainText('尚未儲存');
  await expect(form.getByLabel('實際餘額')).toHaveValue('777');
  await expect(form.getByLabel('備註')).toHaveValue('尚未送出的輸入');
  await page.locator('#tools-dialog .dialog-close').click();
  await expect(page.locator('.account-item').filter({ hasText: '現金' })).toContainText('已對帳');
});

test('同日差額補記後立即相符，重整與往後的新交易不再顯示待調整', async ({ page }) => {
  await page.setViewportSize({ width: 401, height: 784 });
  const state = createEmptyState();
  state.accounts.find(account => account.id === 'cash').openingBalance = 1000;
  await page.addInitScript(state => {
    if (!localStorage.getItem('hukeep_personal_state_v1')) localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state));
  }, state);
  await page.route('https://**', route => route.abort());
  await page.goto('./');
  await page.getByRole('button', { name: '備份與設定' }).click();
  const form = page.locator('#reconciliation-form');
  await form.locator('select[name="accountId"]').selectOption('cash');
  await form.getByLabel('實際餘額').fill('900');
  await form.getByRole('button', { name: '儲存對帳結果' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('差額 -NT$ 100');
  await page.locator('#tools-dialog .dialog-close').click();
  const cash = page.locator('[data-account-history="cash"]');
  await expect(cash).toContainText('差 NT$ 100');
  const addEntry = async (time, text) => {
    await page.clock.setFixedTime(new Date(time));
    await page.getByRole('button', { name: '快速記一筆' }).click();
    await page.getByLabel('口語記帳內容').fill(text);
    await page.getByRole('button', { name: '直接記帳' }).click();
    await expect(page.locator('#transaction-dialog')).not.toBeVisible();
  };
  await addEntry('2026-09-29T04:01:00.000Z', '午餐 100 元用現金支付');
  await expect(cash).toContainText('NT$ 900');
  await expect(cash).not.toContainText('差 NT$');
  await cash.click();
  await expect(page.locator('.account-history')).toContainText('補記後相符');
  await expect(page.locator('.account-history')).not.toContainText('待調整');
  await page.screenshot({ path: 'test-results/reconciliation-supplement-matched.png', animations: 'disabled' });
  await page.locator('#workspace-dialog .dialog-close').click();
  await addEntry('2026-09-29T04:02:00.000Z', '咖啡 50 元用現金支付');
  await page.reload();
  await expect(cash).toContainText('NT$ 850');
  await expect(cash).not.toContainText('差 NT$');
  await cash.click();
  await expect(page.locator('.account-history')).toContainText('補記後相符');
  await expect(page.locator('.account-history')).toContainText('對帳後淨流動 -NT$ 50');
  await page.locator('#workspace-dialog .dialog-close').click();
  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(page.locator('#reconciliation-list')).toContainText('帳本 NT$ 900 · 實際 NT$ 900 · 一致');
  await expect(page.getByRole('button', { name: '建立差額調整' })).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hukeep_personal_state_v1')));
  expect(saved.transactions).toHaveLength(2);
  expect(saved.transactions.some(item => item.category === '帳務調整')).toBe(false);
  expect(saved.featureSettings.reconciliations).toHaveLength(1);
  expect(saved.featureSettings.reconciliations[0].includedTransactionIds).toHaveLength(1);
});

test('既有補記已對齊的舊資料重新開啟時自動修復，不改交易或餘額', async ({ page }) => {
  const state = createEmptyState();
  state.accounts.find(account => account.id === 'cash').openingBalance = 1000;
  state.featureSettings.reconciliations = [{ id: 'old-unresolved', accountId: 'cash', actualBalance: 900,
    estimatedBalance: 1000, date: '2026-09-29', createdAt: '2026-09-29T03:00:00.000Z' }];
  state.transactions = [{ id: 'old-supplement', name: '漏記午餐', category: '飲食', subcategory: '正餐',
    type: 'expense', account: 'cash', amount: 100, date: '2026-09-29', createdAt: '2026-09-29T03:01:00.000Z' }];
  await page.addInitScript(state => localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state)), state);
  await page.route('https://**', route => route.abort());
  await page.goto('./');
  const cash = page.locator('[data-account-history="cash"]');
  await expect(cash).toContainText('NT$ 900');
  await expect(cash).not.toContainText('差 NT$');
  await cash.click();
  await expect(page.locator('.account-history')).toContainText('補記後相符');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hukeep_personal_state_v1')));
  expect(saved.transactions).toHaveLength(1);
  expect(saved.featureSettings.reconciliations[0]).toMatchObject({ id: 'old-unresolved', includedTransactionIds: ['old-supplement'] });
});

test('另一裝置補記讀回時即時解除已開啟畫面的差額，只回傳對帳狀態更新', async ({ page }) => {
  const local = createEmptyState();
  local.accounts.find(account => account.id === 'cash').openingBalance = 1000;
  local.featureSettings.monthlySnapshots = [createMonthlySnapshot(local, '2026-08')];
  local.featureSettings.reconciliations = [{ id: 'remote-supplement-check', accountId: 'cash', actualBalance: 900,
    estimatedBalance: 1000, date: '2026-09-29', createdAt: '2026-09-29T03:00:00.000Z' }];
  const remote = structuredClone(local);
  remote.transactions = [{ id: 'remote-supplement', name: '另一裝置補記午餐', type: 'expense', amount: 100,
    category: '飲食', subcategory: '正餐', account: 'cash', date: '2026-09-29', createdAt: '2026-09-29T03:01:00.000Z' }];
  let releasePull;
  const pullGate = new Promise(resolve => { releasePull = resolve; });
  const checkpointWrites = [];
  await page.route('https://proxy.example/reconciliation-supplement', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'loadLedgerState') {
      await pullGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: remote }) });
      return;
    }
    expect(body.action).toBe('syncLedgerChanges');
    const checkpoints = body.changes.featureSettingsDelta?.reconciliations;
    if (checkpoints?.some(item => item.id === 'remote-supplement-check')) {
      checkpointWrites.push(body.changes);
      remote.featureSettings.reconciliations = checkpoints;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true,
      data: { accountCount: 6, transactionCount: 1, budgetCount: 0, featureSettingsVersion: 1 } }) });
  });
  await page.addInitScript(state => {
    if (!localStorage.getItem('hukeep_personal_state_v1')) localStorage.setItem('hukeep_personal_state_v1', JSON.stringify(state));
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://proxy.example/reconciliation-supplement');
    localStorage.setItem('hukeep_device_binding_token_v1', 'test-only-token');
  }, local);
  await page.goto('./');
  await page.locator('[data-account-history="cash"]').click();
  await expect(page.locator('.account-history')).toContainText('待調整');
  releasePull();
  await expect(page.locator('.account-history')).toContainText('補記後相符');
  await expect(page.locator('.account-history')).not.toContainText('待調整');
  await expect(page.locator('.account-history-current')).toContainText('NT$ 900');
  await expect.poll(() => checkpointWrites.length).toBe(1);
  expect(checkpointWrites[0].transactions).toEqual([]);
  expect(checkpointWrites[0].featureSettingsDelta.reconciliations).toMatchObject([
    { id: 'remote-supplement-check', includedTransactionIds: ['remote-supplement'] },
  ]);
  await page.reload();
  await expect(page.locator('[data-account-history="cash"]')).not.toContainText('差 NT$');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hukeep_personal_state_v1')));
  expect(saved.transactions).toHaveLength(1);
  expect(saved.featureSettings.reconciliations).toHaveLength(1);
});
