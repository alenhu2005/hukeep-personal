import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('可新增收支、重新整理仍保留並透過歷史搜尋', async ({ page }) => {
  await expect(page).toHaveTitle('小帳｜個人記帳');
  await expect(page.getByRole('heading', { name: '這個月，把錢用在哪裡？' })).toBeVisible();

  await page.getByRole('button', { name: '快速記一筆' }).click();
  const transactionForm = page.locator('#transaction-form');
  await expect(page.locator('#category-field')).toBeHidden();
  await expect(page.locator('#subcategory-field')).toBeHidden();
  await expect(
    page.locator('[data-account-for="transaction-account"] button'),
  ).toHaveCount(5);
  await page
    .locator('[data-account-for="transaction-account"]')
    .getByRole('button', { name: '永豐' })
    .click();
  await transactionForm.getByLabel('金額').fill('120');
  await transactionForm.getByLabel('備註').fill('鼎王麻辣鍋午餐');
  await page.getByRole('button', { name: '儲存這筆' }).click();

  await expect(page.getByTestId('summary-expense')).toContainText('120');
  await expect(page.getByText('鼎王麻辣鍋午餐')).toBeVisible();

  const initial = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions[0],
  );
  expect(initial).toMatchObject({
    category: '飲食',
    subcategory: '火鍋',
    account: 'sinopac',
  });

  await page.reload();
  await expect(page.getByTestId('summary-expense')).toContainText('120');

  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.getByLabel('搜尋紀錄').fill('鼎王');
  await expect(page.locator('[data-transaction-row]')).toHaveCount(1);
  await expect(page.getByText('鼎王麻辣鍋午餐')).toBeVisible();

  await page.getByRole('button', { name: '編輯 鼎王麻辣鍋午餐' }).click();
  await expect(page.locator('#category-field')).toBeVisible();
  await expect(page.locator('#subcategory-field')).toBeVisible();
  await expect(transactionForm.getByLabel('大分類')).toHaveValue('飲食');
  await expect(transactionForm.getByLabel('小分類')).toHaveValue('火鍋');
  await transactionForm.getByLabel('小分類').selectOption('便當');
  await page.getByRole('button', { name: '儲存這筆' }).click();

  const corrected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions[0],
  );
  expect(corrected.subcategory).toBe('便當');
});

test('收入也在背景分類，事後編輯才顯示分類', async ({ page }) => {
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByRole('button', { name: '收入', exact: true }).click();
  const form = page.locator('#transaction-form');
  await expect(page.locator('#category-field')).toBeHidden();
  await expect(page.locator('#subcategory-field')).toBeHidden();
  await page
    .locator('[data-account-for="transaction-account"]')
    .getByRole('button', { name: '台銀' })
    .click();
  await form.getByLabel('金額').fill('1200');
  await form.getByLabel('備註').fill('週末家教費');
  await page.getByRole('button', { name: '儲存這筆' }).click();

  await expect(page.getByTestId('summary-income')).toContainText('1,200');
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions[0],
  );
  expect(saved).toMatchObject({
    type: 'income',
    category: '接案',
    subcategory: '家教',
    account: 'bot',
  });

  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await page.getByRole('button', { name: '編輯 週末家教費' }).click();
  await expect(page.locator('#category-field')).toBeVisible();
  await expect(page.locator('#subcategory-field')).toBeVisible();
  await expect(form.getByLabel('大分類')).toHaveValue('接案');
  await expect(form.getByLabel('小分類')).toHaveValue('家教');
});

test('載具同步會以發票號碼取代重複 OCR，並保留細分類', async ({ page }) => {
  await page.evaluate(() => {
    const key = 'hukeep_personal_state_v1';
    const state = {
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '錢', openingBalance: 0 },
        { id: 'bank', name: '銀行', icon: '銀', openingBalance: 0 },
        { id: 'card', name: '信用卡', icon: '卡', openingBalance: 0 },
      ],
      budgets: [],
      preferences: { theme: 'system' },
      transactions: [
      {
        id: 'ocr-existing',
        type: 'expense',
        amount: 120,
        category: '飲食',
        subcategory: '咖啡',
        account: 'card',
        toAccount: null,
        date: '2026-08-28',
        note: '星巴克',
        source: 'ocr',
        sourceId: 'ocr-shot',
        invoiceNumber: 'AB12345678',
        createdAt: '2026-08-28T08:00:00.000Z',
        updatedAt: '2026-08-28T08:00:00.000Z',
      },
      ],
    };
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.reload();
  await page.route('https://proxy.example/**', route =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          invoices: [
            {
              sourceId: 'carrier:AB12345678',
              invoiceNumber: 'AB12345678',
              amount: 125,
              date: '2026-08-28',
              merchant: '星巴克咖啡',
              items: ['大杯拿鐵'],
              classification: {
                topCategory: '飲食',
                subcategory: '咖啡',
                confidence: 0.96,
              },
            },
            {
              sourceId: 'carrier:CD87654321',
              invoiceNumber: 'CD87654321',
              amount: 680,
              date: '2026-08-27',
              merchant: '鼎王麻辣鍋',
              items: ['麻辣鍋'],
              classification: {
                topCategory: '飲食',
                subcategory: '火鍋',
                confidence: 0.94,
              },
            },
          ],
        },
      }),
    }),
  );

  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.getByRole('button', { name: '智慧匯入' }).click();
  await page.getByLabel('私人代理網址').fill('https://proxy.example/sync');
  await page.getByLabel('代理通行碼').fill('proxy-token');
  await page.getByLabel('手機條碼').fill('/ABC+123');
  await page.getByLabel('載具驗證碼').fill('carrier-password');
  await page.getByLabel('同步月份').fill('2026-08');
  await page.getByRole('button', { name: '同步並自動去重' }).click();

  await expect(page.getByText('同步完成：新增 1、合併 1、略過 0。')).toBeVisible();
  const transactions = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions,
  );
  expect(transactions).toHaveLength(2);
  expect(transactions.every(transaction => transaction.source === 'carrier')).toBe(true);
  expect(transactions.map(transaction => transaction.subcategory).sort()).toEqual(['咖啡', '火鍋']);
});

test('可用一句口語內容產生可確認的記帳草稿', async ({ page }) => {
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.locator('#voice-entry > summary').click();
  await page.getByLabel('口語記帳內容').fill('昨天搭高鐵 1490 元刷卡');
  await page.getByRole('button', { name: '解析', exact: true }).click();

  const form = page.locator('#transaction-form');
  await expect(form.getByLabel('金額')).toHaveValue('1490');
  await expect(page.locator('#category-field')).toBeHidden();
  await expect(page.locator('#subcategory-field')).toBeHidden();
  await expect(form.getByLabel('大分類')).toHaveValue('交通');
  await expect(form.getByLabel('小分類')).toHaveValue('高鐵火車');
  await expect(form.locator('#transaction-account')).toHaveValue('sinopac');
  await expect(form.getByLabel('日期')).toHaveValue('2026-08-28');
  await expect(page.getByText(/本機分類完成/)).toBeVisible();

  await page.getByRole('button', { name: '儲存這筆' }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions[0],
  );
  expect(saved).toMatchObject({
    amount: 1490,
    category: '交通',
    subcategory: '高鐵火車',
    account: 'sinopac',
    date: '2026-08-28',
  });
});

test('可設定分類預算、查看趨勢並在手機使用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '預算' }).click();
  await page.getByLabel('預算分類').selectOption('飲食');
  await page.getByLabel('每月上限').fill('5000');
  await page.getByRole('button', { name: '儲存預算' }).click();
  await expect(page.getByText('飲食預算')).toBeVisible();

  await page.getByRole('button', { name: '趨勢' }).click();
  await expect(page.getByRole('heading', { name: '六個月的流向' })).toBeVisible();
  await expect(page.locator('#trend-chart')).toBeVisible();
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
});

test('PWA 在正式 build 路徑註冊獨立 service worker', async ({ page }) => {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.scope || '';
      }),
    )
    .toContain('/hukeep-personal/');
});
