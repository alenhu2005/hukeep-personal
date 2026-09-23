import { expect, test } from '@playwright/test';
import { encryptLoginData } from '../../src/services/tw-einvoice-v2.ts';

test('手機可唯讀預覽發票，關閉設定即清除憑證與結果', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-09-19T04:00:00.000Z'));
  await page.addInitScript(() => {
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://example.com/exec');
    localStorage.setItem('hukeep_device_binding_token_v1', 'test-proxy-token');
  });
  const session = {
    sid: '123456789012345678',
    token: 't'.repeat(64),
    liat: 1783947541,
    ssme: 'synthetic-signing-secret',
    appid: 'synthetic-app-id',
    carrier_code: '/ABCD1234',
  };
  const requests = [];
  await page.route('https://example.com/exec', async route => {
    const request = route.request().postDataJSON();
    requests.push(request);
    let body;
    if (request.action === 'relayEInvoicePreview' && request.stage === 'login') {
      body = { result: 0, payload: await encryptLoginData(session) };
    } else if (request.action === 'relayEInvoicePreview' && request.stage === 'list') {
      const claim = JSON.parse(Buffer.from(request.payload.split('.')[1], 'base64url').toString());
      body = { result: 0, payload: { data: claim.reqdata.startDate === '2026/09/01'
        ? [{ invNum: 'AA-12345678', invDate: { year: '115', month: '9', date: '18' }, sellerName: '測試商店', amount: '120' }]
        : [] } };
    } else if (request.action === 'relayEInvoicePreview' && request.stage === 'detail') {
      body = { result: 0, payload: { details: [{ itemName: '豆漿', quantity: '2', amount: '120' }] } };
    } else {
      body = { schemaVersion: 1, accounts: [], transactions: [], budgets: [] };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: request.action === 'relayEInvoicePreview' ? { status: 200, body } : body }),
    });
  });

  await page.goto('./');
  await page.getByRole('button', { name: '備份與設定' }).click();
  const dialog = page.locator('#tools-dialog');
  const form = dialog.locator('#einvoice-preview-form');
  await form.getByLabel('電子發票 App 手機號碼').fill('0912345678');
  await form.getByLabel('電子發票 App 密碼').fill('test-password');
  await form.getByRole('button', { name: '登入並預覽' }).click();
  await expect(dialog.locator('#einvoice-preview-status')).toContainText('已讀取 1 張發票');
  await expect(dialog.getByText('測試商店', { exact: false })).toBeVisible();
  await expect(form.getByLabel('電子發票 App 密碼')).toHaveValue('');
  await expect(dialog.getByText('豆漿')).toHaveCount(0);
  await dialog.locator('.einvoice-preview-row summary').click();
  await expect(dialog.getByText('豆漿', { exact: false })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.filter(request => request.action === 'relayEInvoicePreview').map(request => request.stage))
    .toEqual(['login', 'list', 'list', 'detail']);
  expect(requests.find(request => request.stage === 'login').payload).not.toContain('test-password');
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('test-password')))).toBe(false);

  await dialog.locator('.dialog-close').click();
  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(dialog.locator('.einvoice-preview-row')).toHaveCount(0);
  await expect(form.getByLabel('電子發票 App 手機號碼')).toHaveValue('');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions)).toEqual([]);
});
