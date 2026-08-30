import { describe, expect, it, vi } from 'vitest';
import * as importProxy from '../src/services/import-proxy.js';
import {
  claimDevicePairingCode,
  classifyExpenseWithAi,
  createDevicePairingCode,
  deleteLedgerBudgetFromSheet,
  deleteLedgerTransactionFromSheet,
  enqueueSpokenEntry,
  loadLedgerStateFromSheet,
  syncLedgerStateToSheet,
  validateProxyEndpoint,
} from '../src/services/import-proxy.js';

describe('智慧匯入代理', () => {
  it('不再匯出財政部載具同步 API', () => {
    expect(importProxy).not.toHaveProperty('syncCarrierInvoices');
  });

  it('只允許 HTTPS 或本機開發網址', () => {
    expect(validateProxyEndpoint('https://example.com/proxy')).toBe('https://example.com/proxy');
    expect(validateProxyEndpoint('http://localhost:8787')).toBe('http://localhost:8787/');
    expect(() => validateProxyEndpoint('http://example.com')).toThrow('HTTPS');
  });

  it('已綁定裝置可產生一次性手機短碼', async () => {
    const expiresAt = '2026-08-29T16:30:00.000Z';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { code: 'ABCD-EFGH', expiresAt } }),
    });

    await expect(
      createDevicePairingCode(
        { endpoint: 'https://example.com/proxy', proxyToken: 'bound-device-value' },
        { fetchImpl },
      ),
    ).resolves.toEqual({ code: 'ABCD-EFGH', expiresAt });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'createDevicePairingCode',
      proxyToken: 'bound-device-value',
    });
  });

  it('手機可輸入短碼兌換裝置綁定，不先傳長期權杖', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { proxyToken: 'new-mobile-device-value' } }),
    });

    await expect(
      claimDevicePairingCode(
        { endpoint: 'https://example.com/proxy', code: 'abcd efgh' },
        { fetchImpl },
      ),
    ).resolves.toEqual({ proxyToken: 'new-mobile-device-value' });
  });

  it('AI 分類只傳商家與品項，不傳發票號碼或付款憑證', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { topCategory: '飲食', subcategory: '甜品', confidence: 0.93 },
      }),
    });

    await expect(
      classifyExpenseWithAi(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'secret-token',
          merchant: '甜點店',
          items: ['發票號碼 AB12345678', '蛋糕'],
          fallback: { topCategory: '其他', subcategory: '其他支出', confidence: 0 },
        },
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ topCategory: '飲食', subcategory: '甜品' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      action: 'classifyExpense',
      items: ['蛋糕'],
    });
  });

  it('收入分類使用收入操作', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: { topCategory: '中獎', subcategory: '發票中獎', confidence: 0.97 },
      }),
    });
    await classifyExpenseWithAi(
      {
        type: 'income',
        endpoint: 'https://example.com/proxy',
        proxyToken: 'token',
        merchant: '發票中獎',
        items: ['發票中獎'],
        fallback: { topCategory: '其他收入', subcategory: '其他收入', confidence: 0 },
      },
      { fetchImpl },
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).action).toBe('classifyIncome');
  });

  it('只將帳本內容同步至 Sheet，不傳偏好或任何載具資料', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { accountCount: 1, transactionCount: 1, budgetCount: 0 } }),
    });
    const state = {
      schemaVersion: 1,
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 5000 }],
      transactions: [{
        id: 'tx-1', type: 'expense', amount: 120, account: 'cash', toAccount: null,
        date: '2026-08-29', name: '午餐', category: '飲食', subcategory: '便當',
      }],
      budgets: [],
      preferences: { proxyToken: 'must-not-persist' },
    };

    await expect(
      syncLedgerStateToSheet(
        { endpoint: 'https://example.com/proxy', proxyToken: 'token', state },
        { fetchImpl },
      ),
    ).resolves.toEqual({ accountCount: 1, transactionCount: 1, budgetCount: 0 });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).state).not.toHaveProperty('preferences');
  });

  it('同步時保留轉帳手續費，讓 Sheet 能正確計算帳戶與總資產', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { accountCount: 2, transactionCount: 1, budgetCount: 0 } }),
    });
    await syncLedgerStateToSheet({
      endpoint: 'https://example.com/proxy',
      proxyToken: 'token',
      state: {
        accounts: [
          { id: 'cash', name: '現金', openingBalance: 1000 },
          { id: 'line', name: 'LINE', openingBalance: 0 },
        ],
        transactions: [{
          id: 'transfer-1', type: 'transfer', amount: 300, fee: 15,
          account: 'cash', toAccount: 'line', date: '2026-08-29', name: '帳戶轉帳',
        }],
        budgets: [],
      },
    }, { fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).state.transactions[0]).toMatchObject({
      id: 'transfer-1',
      amount: 300,
      fee: 15,
    });
  });

  it('刪除交易與預算時，要求 GAS 實際移除指定的 Sheet 資料列', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { deleted: true } }),
    });
    const session = { endpoint: 'https://example.com/proxy', proxyToken: 'token' };

    await expect(
      deleteLedgerTransactionFromSheet({ ...session, transactionId: 'voice:queue-1' }, { fetchImpl }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      deleteLedgerBudgetFromSheet({ ...session, category: '飲食' }, { fetchImpl }),
    ).resolves.toEqual({ deleted: true });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      action: 'deleteLedgerTransaction',
      proxyToken: 'token',
      transactionId: 'voice:queue-1',
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      action: 'deleteLedgerBudget',
      proxyToken: 'token',
      category: '飲食',
    });
  });

  it('從 Sheet 讀取時驗證完整帳本結構', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { schemaVersion: 1, accounts: [], transactions: [], budgets: [] } }),
    });

    await expect(
      loadLedgerStateFromSheet(
        { endpoint: 'https://example.com/proxy', proxyToken: 'token' },
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ schemaVersion: 1, transactions: [] });
  });

  it('口語記帳直接送進 Sheet 後台佇列，不等待 AI 才回應', async () => {
    const transaction = { id: 'voice:queue-1', type: 'expense', amount: 1200, account: 'sinopac', date: '2026-08-28' };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { queueId: 'queue-1', status: 'pending', transaction } }),
    });

    await expect(
      enqueueSpokenEntry(
        {
          endpoint: 'https://example.com/proxy',
          proxyToken: 'session-token',
          transcript: '昨天用永豐在鼎王吃麻辣鍋一千二',
          draft: { ...transaction, name: '鼎王麻辣鍋', note: '' },
        },
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ queueId: 'queue-1', status: 'pending' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      action: 'enqueueSpokenEntry',
      transcript: '昨天用永豐在鼎王吃麻辣鍋一千二',
      draft: { note: '' },
    });
  });

  it('口語轉帳會把辨識到的手續費送給 GAS 與 AI 後台', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { queueId: 'queue-fee', status: 'pending', transaction: null } }),
    });

    await enqueueSpokenEntry({
      endpoint: 'https://example.com/proxy',
      proxyToken: 'session-token',
      transcript: '從永豐轉三千到郵局，手續費十五元',
      draft: {
        type: 'transfer', amount: 3000, fee: 15, account: 'sinopac', toAccount: 'post',
        date: '2026-08-29', name: '帳戶轉帳', note: '',
      },
    }, { fetchImpl });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).draft).toMatchObject({
      type: 'transfer', amount: 3000, fee: 15, account: 'sinopac', toAccount: 'post',
    });
  });
});
