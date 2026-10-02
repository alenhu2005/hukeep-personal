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
