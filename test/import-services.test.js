import { describe, expect, it, vi } from 'vitest';
import {
  classifyExpenseWithAi,
  syncCarrierInvoices,
  validateProxyEndpoint,
} from '../src/services/import-proxy.js';

describe('智慧匯入代理', () => {
  it('只允許 HTTPS 或本機開發網址', () => {
    expect(validateProxyEndpoint('https://example.com/proxy')).toBe('https://example.com/proxy');
    expect(validateProxyEndpoint('http://localhost:8787')).toBe('http://localhost:8787/');
    expect(() => validateProxyEndpoint('http://example.com')).toThrow('HTTPS');
    expect(() => validateProxyEndpoint('javascript:alert(1)')).toThrow('網址');
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
      json: async () => ({ ok: true, data: { invoices } }),
    });

    await expect(
      syncCarrierInvoices(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'token',
          cardNo: '/ABC+123',
          cardEncrypt: 'password',
          month: '2026-08',
        },
        { fetchImpl },
      ),
    ).resolves.toEqual(invoices);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'syncCarrierInvoices',
      proxyToken: 'token',
      cardNo: '/ABC+123',
      cardEncrypt: 'password',
      month: '2026-08',
    });
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
});
