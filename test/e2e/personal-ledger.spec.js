import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
});

test('可新增收支、重新整理仍保留並透過歷史搜尋', async ({ page }) => {
  await expect(page).toHaveTitle('小帳｜個人記帳');
  await expect(page.getByRole('heading', { name: '這個月，把錢用在哪裡？' })).toBeVisible();

  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByText('需要手動輸入？展開詳細記帳').click();
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
  await transactionForm.getByLabel('名稱').fill('鼎王麻辣鍋午餐');
  await transactionForm.getByLabel('備註').fill('和朋友聚餐');
  await page.getByRole('button', { name: '儲存這筆' }).click();

  await expect(page.getByTestId('summary-expense')).toContainText('120');
  await expect(page.getByTestId('total-assets')).toContainText('-NT$ 120');
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

test('智慧匯入只保留截圖 OCR 與 AI 分類，不再顯示載具同步', async ({ page }) => {
  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.getByRole('button', { name: '智慧匯入' }).click();

  await expect(page.getByRole('heading', { name: '截圖自動記帳' })).toBeVisible();
  await expect(page.locator('#carrier-form')).toHaveCount(0);
  await expect(page.getByText('財政部載具同步')).toHaveCount(0);
  await expect(page.getByText('載具驗證碼')).toHaveCount(0);
});

test('手機記帳移除多餘分類提示，且長對話框仍固定保留關閉按鈕', async ({ page }) => {
  await page.setViewportSize({ width: 399, height: 784 });
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await expect(page.locator('#classification-status')).toHaveCount(0);
  await expect(page.locator('#manual-entry')).not.toHaveAttribute('open', '');
  await expect(page.getByText('需要手動輸入？展開詳細記帳')).toBeVisible();
  await expect(page.locator('[data-account-for="transaction-account"] button')).toHaveCount(5);
  await expect
    .poll(() =>
      page.locator('div[data-account-for="transaction-account"]').evaluate(element =>
        getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
    )
    .toBe(5);
  await page.locator('#transaction-dialog .dialog-close').click();

  await page.getByRole('button', { name: '紀錄', exact: true }).click();
  await expect(page.locator('#history-type, #history-account')).toHaveCount(0);
  await expect(page.locator('[data-history-filter="type"]')).toHaveCount(4);
  await expect(page.locator('[data-history-filter="account"]')).toHaveCount(6);
  await page.locator('[data-history-filter="type"][data-history-value="expense"]').click();
  await expect(
    page.locator('[data-history-filter="type"][data-history-value="expense"]'),
  ).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '備份與設定' }).click();
  const dialog = page.locator('#tools-dialog');
  await dialog.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      page.locator('#tools-dialog .dialog-close').evaluate(button => {
        const dialogBox = button.closest('dialog').getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        return buttonBox.top >= dialogBox.top && buttonBox.bottom <= dialogBox.top + 72;
      }),
    )
    .toBe(true);
});

test('收入也在背景分類，事後編輯才顯示分類', async ({ page }) => {
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await page.getByText('需要手動輸入？展開詳細記帳').click();
  await page.getByRole('button', { name: '收入', exact: true }).click();
  const form = page.locator('#transaction-form');
  await expect(page.locator('#category-field')).toBeHidden();
  await expect(page.locator('#subcategory-field')).toBeHidden();
  await page
    .locator('[data-account-for="transaction-account"]')
    .getByRole('button', { name: '台銀' })
    .click();
  await form.getByLabel('金額').fill('1200');
  await form.getByLabel('名稱').fill('週末家教費');
  await form.getByLabel('備註').fill('週六數學家教');
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

test('口語內容直接上傳 Sheet，不等待 AI 審查', async ({ page }) => {
  let receivedBody;
  await page.route('https://proxy.example/voice', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'loadLedgerState') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { schemaVersion: 1, accounts: [], transactions: [], budgets: [] },
        }),
      });
      return;
    }
    receivedBody = body;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          queueId: 'queue-e2e',
          status: 'pending',
          transaction: {
            id: 'voice:queue-e2e',
            type: 'expense',
            name: '高鐵車票',
            amount: 1490,
            category: '交通',
            subcategory: '高鐵火車',
            account: 'sinopac',
            toAccount: '',
            date: '2026-08-28',
            note: '',
            source: 'voice',
            sourceId: 'queue-e2e',
            aiStatus: 'pending',
            rawTranscript: '昨天搭高鐵 1490 元刷卡',
            createdAt: '2026-08-29T06:00:00.000Z',
            updatedAt: '2026-08-29T06:00:00.000Z',
          },
        },
      }),
    });
  });
  await page.evaluate(() => {
    const key = 'hukeep_personal_state_v1';
    const state = {
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
        { id: 'line', name: 'LINE', icon: 'L', openingBalance: 0 },
        { id: 'sinopac', name: '永豐', icon: '永', openingBalance: 0 },
        { id: 'bot', name: '台銀', icon: '台', openingBalance: 0 },
        { id: 'post', name: '郵局', icon: '郵', openingBalance: 0 },
      ],
      transactions: [],
      budgets: [],
      preferences: { theme: 'system', proxyEndpoint: 'https://proxy.example/voice' },
    };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('hukeep_device_binding_token_v1', 'session-token');
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://proxy.example/voice');
  });
  await page.reload();
  await page.getByRole('button', { name: '快速記一筆' }).click();
  await expect(page.getByRole('button', { name: '開始說話' })).toHaveCount(0);
  await page.getByLabel('口語記帳內容').fill('昨天搭高鐵 1490 元刷卡');
  await expect(page.getByRole('button', { name: '解析', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '直接記帳', exact: true }).click();
  await expect(page.getByText('已上傳 Sheet，AI 會在後台審查更新。')).toBeVisible();

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions[0],
  );
  expect(saved).toMatchObject({
    amount: 1490,
    category: '交通',
    subcategory: '高鐵火車',
    account: 'sinopac',
    date: '2026-08-28',
    name: '高鐵車票',
    aiStatus: 'pending',
  });
  expect(receivedBody).toMatchObject({
    action: 'enqueueSpokenEntry',
    proxyToken: 'session-token',
    transcript: '昨天搭高鐵 1490 元刷卡',
    draft: { note: '' },
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

test('手機掃描綁定連結後可直接連線，並會清除網址中的綁定資料', async ({ page }) => {
  const payload = await page.evaluate(() => {
    const encoded = btoa(JSON.stringify({
      v: 1,
      endpoint: 'https://proxy.example/mobile',
      proxyToken: 'mobile-device-token',
    }));
    return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  });

  await page.goto(`./#bind=${payload}`);
  await page.reload();
  await expect(page).toHaveURL(/#overview$/);
  expect(await page.evaluate(() => ({
    endpoint: localStorage.getItem('hukeep_device_binding_endpoint_v1'),
    bindingValue: localStorage.getItem('hukeep_device_binding_token_v1'),
  }))).toEqual({
    endpoint: 'https://proxy.example/mobile',
    bindingValue: 'mobile-device-token',
  });

  await page.getByRole('button', { name: '備份與設定' }).click();
  await expect(page.getByText('這台裝置已安全綁定 Sheet')).toBeVisible();
  await page.route('https://proxy.example/mobile', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { code: 'ABCD-EFGH', expiresAt: '2026-08-29T16:30:00.000Z' },
      }),
    });
  });
  await page.getByRole('button', { name: '綁定手機' }).click();
  await expect(page.locator('#device-binding-qr')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.getByText('ABCD-EFGH', { exact: true })).toBeVisible();
});

test('手機可直接輸入一次性短碼完成綁定', async ({ page }) => {
  let receivedBody;
  await page.route('https://script.google.com/**', async route => {
    receivedBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { proxyToken: 'paired-mobile-value' },
      }),
    });
  });

  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.getByLabel('手機綁定碼').fill('abcd-efgh');
  await page.getByRole('button', { name: '使用綁定碼' }).click();

  await expect(page.getByText('這台裝置已安全綁定 Sheet')).toBeVisible();
  expect(receivedBody).toEqual({ action: 'claimDeviceBinding', code: 'ABCDEFGH' });
});

test('可設定帳戶初始金額並安全同步到 Google Sheet', async ({ page }) => {
  let receivedBody;
  await page.route('https://proxy.example/sheet', async route => {
    receivedBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { accountCount: 5, transactionCount: 0, budgetCount: 0 },
      }),
    });
  });

  await page.evaluate(() => {
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://proxy.example/sheet');
    localStorage.setItem('hukeep_device_binding_token_v1', 'session-token');
  });
  await page.reload();

  await page.getByRole('button', { name: '備份與設定' }).click();
  await page.getByLabel('現金初始金額').fill('15000');
  await page.getByLabel('永豐初始金額').fill('-1200');
  await page.getByRole('button', { name: '儲存初始金額' }).click();

  const savedAccounts = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).accounts,
  );
  expect(savedAccounts.find(account => account.id === 'cash').openingBalance).toBe(15000);
  expect(savedAccounts.find(account => account.id === 'sinopac').openingBalance).toBe(-1200);

  await page.getByRole('button', { name: '同步到 Google Sheet' }).click();

  await expect(page.getByText('同步完成：5 個帳戶、0 筆交易、0 筆預算。')).toBeVisible();
  await expect(page.locator('#sync-indicator')).toContainText('已同步');
  expect(receivedBody).toMatchObject({
    action: 'syncLedgerState',
    proxyToken: 'session-token',
    state: {
      accounts: expect.arrayContaining([
        { id: 'cash', name: '現金', openingBalance: 15000 },
        { id: 'sinopac', name: '永豐', openingBalance: -1200 },
      ]),
      transactions: [],
      budgets: [],
    },
  });
});

test('Sheet 刪除既有交易後，從 Sheet 讀取會同步移除網頁資料', async ({ page }) => {
  await page.route('https://proxy.example/authoritative', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: {
          schemaVersion: 1,
          accounts: [
            { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
            { id: 'line', name: 'LINE', icon: 'L', openingBalance: 0 },
            { id: 'sinopac', name: '永豐', icon: '永', openingBalance: 0 },
            { id: 'bot', name: '台銀', icon: '台', openingBalance: 0 },
            { id: 'post', name: '郵局', icon: '郵', openingBalance: 0 },
          ],
          transactions: [
            {
              id: 'sheet-kept',
              type: 'expense',
              name: 'Sheet 保留資料',
              amount: 80,
              category: '飲食',
              subcategory: '早餐',
              account: 'cash',
              date: '2026-08-29',
              source: 'manual',
              createdAt: '2026-08-29T01:00:00.000Z',
              updatedAt: '2026-08-29T01:00:00.000Z',
            },
          ],
          budgets: [],
        },
      }),
    });
  });
  await page.evaluate(() => {
    const transaction = (id, name, amount) => ({
      id,
      type: 'expense',
      name,
      amount,
      category: '飲食',
      subcategory: '早餐',
      account: 'cash',
      date: '2026-08-29',
      source: 'manual',
      createdAt: '2026-08-29T01:00:00.000Z',
      updatedAt: '2026-08-29T01:00:00.000Z',
    });
    localStorage.setItem('hukeep_personal_state_v1', JSON.stringify({
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
        { id: 'line', name: 'LINE', icon: 'L', openingBalance: 0 },
        { id: 'sinopac', name: '永豐', icon: '永', openingBalance: 0 },
        { id: 'bot', name: '台銀', icon: '台', openingBalance: 0 },
        { id: 'post', name: '郵局', icon: '郵', openingBalance: 0 },
      ],
      transactions: [
        transaction('sheet-kept', 'Sheet 保留資料', 80),
        transaction('deleted-in-sheet', 'Sheet 已刪資料', 120),
      ],
      budgets: [],
      preferences: { theme: 'system' },
    }));
    localStorage.setItem('hukeep_device_binding_endpoint_v1', 'https://proxy.example/authoritative');
    localStorage.setItem('hukeep_device_binding_token_v1', 'session-token');
  });
  await page.reload();
  await expect(page.getByText('Sheet 已刪資料')).toBeVisible();

  await page.getByRole('button', { name: '備份與設定' }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '從 Sheet 讀取' }).click();

  await expect(page.getByText('讀取完成：5 個帳戶、1 筆交易、0 筆預算。')).toBeVisible();
  const ids = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hukeep_personal_state_v1')).transactions.map(item => item.id),
  );
  expect(ids).toEqual(['sheet-kept']);
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
