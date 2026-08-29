import { describe, expect, it, vi } from 'vitest';
import {
  claimDevicePairingCode,
  classifyExpenseWithAi,
  createDevicePairingCode,
  enqueueSpokenEntry,
  loadLedgerStateFromSheet,
  syncCarrierInvoices,
  syncLedgerStateToSheet,
  validateProxyEndpoint,
} from '../src/services/import-proxy.js';

describe('智慧匯入代理', () => {
  it('只允許 HTTPS 或本機開發網址', () => {
    expect(validateProxyEndpoint('https://example.com/proxy')).toBe('https://example.com/proxy');
    expect(validateProxyEndpoint('http://localhost:8787')).toBe('http://localhost:8787/');
    expect(() => validateProxyEndpoint('http://example.com')).toThrow('HTTPS');
    expect(() => validateProxyEndpoint('javascript:alert(1)')).toThrow('網址');
  });

  it('已綁定裝置可產生一次性手機短碼', async () => {
    const expiresAt = '2026-08-29T16:30:00.000Z';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { code: 'ABCD-EFGH', expiresAt },
      }),
    });

    await expect(
      createDevicePairingCode(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'bound-device-value',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ code: 'ABCD-EFGH', expiresAt });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'createDevicePairingCode',
      proxyToken: 'bound-device-value',
    });
  });

  it('手機可輸入短碼兑換裝置綁定，不先傳長期權杖', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { proxyToken: 'new-mobile-device-value' },
      }),
    });

    await expect(
      claimDevicePairingCode(
        {
          endpoint: 'https://example.com/proxy',
          code: 'abcd efgh',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ proxyToken: 'new-mobile-device-value' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'claimDeviceBinding',
      code: 'ABCDEFGH',
    });
  });

  it('AI 分類只傳商家與品項，不傳發票號碼或載具密碼', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { topCategory: '飲食', subcategory: '甜品', confidence: 0.93 },
      }),
    });

    const result = await classifyExpenseWithAi(
      {
        endpoint: 'https://example.com/proxy',
        proxyToken: 'secret-token',
        merchant: '甜點店',
        items: ['發票號碼 AB12345678', '/ABC+123', '蛋糕'],
        invoiceNumber: 'AB12345678',
        cardEncrypt: 'carrier-password',
      },
      { fetchImpl },
    );

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      action: 'classifyExpense',
      proxyToken: 'secret-token',
      merchant: '甜點店',
      items: ['蛋糕'],
    });
    expect(result).toEqual({ topCategory: '飲食', subcategory: '甜品', confidence: 0.93 });
  });

  it('載具同步傳送必要欄位並驗證回傳陣列', async () => {
    const invoices = [{ invoiceNumber: 'AB12345678', amount: 120 }];
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { invoices, carrierBound: true, syncStartDate: '2026-08-01' },
      }),
    });

    await expect(
      syncCarrierInvoices(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          cardNo: '/ABC+123',
          cardEncrypt: 'password',
          month: '2026-08',
          syncStartDate: '2026-08-01',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ invoices, carrierBound: true, syncStartDate: '2026-08-01' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'syncCarrierInvoices',
      proxyToken: 'token',
      cardNo: '/ABC+123',
      cardEncrypt: 'password',
      month: '2026-08',
      rememberCarrier: false,
      syncStartDate: '2026-08-01',
    });
  });

  it('已綁定載具時可不再傳手機條碼與驗證碼', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { invoices: [], carrierBound: true, syncStartDate: '2026-08-01' },
      }),
    });

    await expect(
      syncCarrierInvoices(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          month: '2026-08',
          rememberCarrier: true,
          syncStartDate: '2026-08-01',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ invoices: [], carrierBound: true, syncStartDate: '2026-08-01' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'syncCarrierInvoices',
      proxyToken: 'token',
      cardNo: '',
      cardEncrypt: '',
      month: '2026-08',
      rememberCarrier: true,
      syncStartDate: '2026-08-01',
    });
  });

  it('拒絕格式不正確的載具自動同步起始日', async () => {
    await expect(
      syncCarrierInvoices({
        endpoint: 'https://example.com/proxy',
        proxyToken: 'token',
        month: '2026-08',
        syncStartDate: '2026-02-30',
      }),
    ).rejects.toThrow('起始日期');
  });

  it('AI 無法判斷時保留本機分類，不降級成其他支出', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { topCategory: '其他', subcategory: '其他支出', confidence: 0 },
      }),
    });
    const fallback = { topCategory: '飲食', subcategory: '火鍋', confidence: 0.9 };

    await expect(
      classifyExpenseWithAi(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          merchant: '鼎王',
          items: ['麻辣鍋'],
          fallback,
        },
        { fetchImpl },
      ),
    ).resolves.toEqual(fallback);
  });

  it('收入分類使用收入 taxonomy 並呼叫收入操作', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { topCategory: '中獎', subcategory: '發票中獎', confidence: 0.97 },
      }),
    });
    const fallback = { topCategory: '其他收入', subcategory: '其他收入', confidence: 0 };

    const result = await classifyExpenseWithAi(
      {
        type: 'income',
        endpoint: 'https://example.com/proxy',
        proxyToken: 'token',
        merchant: '發票中獎',
        items: ['發票中獎'],
        fallback,
      },
      { fetchImpl },
    );

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).action).toBe('classifyIncome');
    expect(result).toEqual({ topCategory: '中獎', subcategory: '發票中獎', confidence: 0.97 });
  });

  it('將代理的失敗訊息轉成可讀錯誤', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: '載具驗證失敗' }),
    });

    await expect(
      syncCarrierInvoices(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          cardNo: '/ABC+123',
          cardEncrypt: 'wrong',
          month: '2026-08',
        },
        { fetchImpl },
      ),
    ).rejects.toThrow('載具驗證失敗');
  });

  it('缺少財政部 AppID 時提供設定位置，而不是只顯示技術欄位名稱', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: '代理尚未完成必要設定：EINVOICE_APP_ID' }),
    });

    await expect(
      syncCarrierInvoices(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          month: '2026-08',
        },
        { fetchImpl },
      ),
    ).rejects.toThrow('GAS 的「專案設定 → 指令碼屬性」加入財政部核發的 AppID');
  });

  it('只將記帳內容同步至 Sheet，不傳偏好或載具資料', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { accountCount: 1, transactionCount: 1, budgetCount: 1 },
      }),
    });
    const state = {
      schemaVersion: 1,
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 5000 }],
      transactions: [
        {
          id: 'tx-1',
          type: 'expense',
          amount: 120,
          category: '飲食',
          subcategory: '火鍋',
          account: 'cash',
          toAccount: null,
          date: '2026-08-29',
          note: '午餐',
          source: 'ocr',
          invoiceNumber: 'AB12345678',
          invoiceItems: ['麻辣鍋'],
          createdAt: '2026-08-29T04:00:00.000Z',
          updatedAt: '2026-08-29T04:00:00.000Z',
        },
      ],
      budgets: [{ category: '飲食', limit: 6000 }],
      preferences: {
        theme: 'dark',
        carrierCardNo: '/ABC+123',
        carrierEndpoint: 'https://secret.example/',
        proxyToken: 'must-not-leak',
      },
    };

    await expect(
      syncLedgerStateToSheet(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'session-only-token',
          state,
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({ accountCount: 1, transactionCount: 1, budgetCount: 1 });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.action).toBe('syncLedgerState');
    expect(body.proxyToken).toBe('session-only-token');
    expect(body.state).toEqual({
      schemaVersion: 1,
      accounts: [{ id: 'cash', name: '現金', openingBalance: 5000 }],
      transactions: [state.transactions[0]],
      budgets: [{ category: '飲食', limit: 6000 }],
    });
    expect(JSON.stringify(body.state)).not.toContain('must-not-leak');
    expect(JSON.stringify(body.state)).not.toContain('/ABC+123');
    expect(body.state.accounts[0]).not.toHaveProperty('icon');
  });

  it('Sheet 同步會在送出前拒絕過量資料', async () => {
    await expect(
      syncLedgerStateToSheet({
        endpoint: 'https://example.com/proxy',
        proxyToken: 'token',
        state: {
          accounts: Array.from({ length: 21 }, (_, index) => ({
            id: `account-${index}`,
            name: `帳戶 ${index}`,
            openingBalance: 0,
          })),
          transactions: [],
          budgets: [],
        },
      }),
    ).rejects.toThrow('帳戶資料過多');
  });

  it('可從 Sheet 讀回帳戶、交易與預算', async () => {
    const sheetState = {
      schemaVersion: 1,
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 5000 }],
      transactions: [
        {
          id: 'voice:1',
          type: 'expense',
          name: '鼎王麻辣鍋',
          amount: 1200,
          category: '飲食',
          subcategory: '火鍋',
          account: 'cash',
          toAccount: null,
          date: '2026-08-28',
          note: '聚餐',
          source: 'voice',
          createdAt: '2026-08-29T06:00:00.000Z',
          updatedAt: '2026-08-29T06:01:00.000Z',
        },
      ],
      budgets: [{ category: '飲食', limit: 5000 }],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: sheetState }),
    });

    await expect(
      loadLedgerStateFromSheet(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'session-token',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual(sheetState);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'loadLedgerState',
      proxyToken: 'session-token',
    });
  });

  it('口語記帳直接送進 Sheet 後台佇列，不等待 AI 才回應', async () => {
    const provisionalTransaction = {
      id: 'voice:queue-1',
      type: 'expense',
      name: '鼎王麻辣鍋',
      amount: 1200,
      category: '飲食',
      subcategory: '火鍋',
      account: 'sinopac',
      toAccount: null,
      date: '2026-08-28',
      note: '',
      source: 'voice',
      sourceId: 'queue-1',
      aiStatus: 'pending',
      createdAt: '2026-08-29T06:00:00.000Z',
      updatedAt: '2026-08-29T06:00:00.000Z',
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { queueId: 'queue-1', status: 'pending', transaction: provisionalTransaction },
      }),
    });

    await expect(
      enqueueSpokenEntry(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'session-token',
          transcript: '昨天用永豐在鼎王吃麻辣鍋一千二',
          draft: provisionalTransaction,
        },
        { fetchImpl },
      ),
    ).resolves.toEqual({
      queueId: 'queue-1',
      status: 'pending',
      transaction: provisionalTransaction,
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'enqueueSpokenEntry',
      proxyToken: 'session-token',
      transcript: '昨天用永豐在鼎王吃麻辣鍋一千二',
      timezone: 'Asia/Taipei',
      draft: {
        type: 'expense',
        amount: 1200,
        category: '飲食',
        subcategory: '火鍋',
        account: 'sinopac',
        toAccount: '',
        date: '2026-08-28',
        name: '鼎王麻辣鍋',
        note: '',
      },
    });
  });

  it('口語記帳拒絕空白內容，不呼叫代理', async () => {
    const fetchImpl = vi.fn();
    await expect(
      enqueueSpokenEntry(
        { endpoint: 'https://example.com/proxy', proxyToken: 'token', transcript: '   ' },
        { fetchImpl },
      ),
    ).rejects.toThrow('口語內容');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
