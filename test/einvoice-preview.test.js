import { describe, expect, it, vi } from 'vitest';
import { decryptLoginData, encryptLoginData } from '../src/services/tw-einvoice-v2.ts';
import { invoiceHeaders, invoiceItems, previewEInvoices } from '../src/services/einvoice-preview.js';

const connection = { endpoint: 'https://example.com/exec', proxyToken: 'test-token' };
const credentials = { mobile: '0912345678', password: ['test', 'password'].join('-') };
const now = new Date('2026-09-19T04:00:00.000Z');
const session = {
  sid: '123456789012345678',
  token: 't'.repeat(64),
  liat: 1783947541,
  ssme: 'synthetic-signing-secret',
  appid: 'synthetic-app-id',
  carrier_code: '/ABCD1234',
};

function fakeRelay(options = {}) {
  const calls = [];
  const relayImpl = vi.fn(async ({ stage, payload }) => {
    calls.push({ stage, payload });
    if (stage === 'login') {
      const login = await decryptLoginData(payload);
      expect(login.account).toBe(credentials.mobile);
      expect(login.password).toBe(credentials.password);
      if (options.loginError) return { status: 200, body: { result: 1, message: 'invalid credentials' } };
      return { status: 200, body: { result: 0, payload: await encryptLoginData(session) } };
    }
    const claim = JSON.parse(Buffer.from(payload.split('.')[1], 'base64url').toString());
    if (stage === 'list') {
      if (options.listError) return { status: 503, body: { message: 'upstream unavailable' } };
      expect(claim.reqdata.action).toBe('carrierInvChk');
      if (options.empty || claim.reqdata.startDate === '2026/07/01') {
        return { status: 200, body: { result: 0, payload: { data: [] } } };
      }
      expect(claim.reqdata.startDate).toBe('2026/09/01');
      expect(claim.reqdata.endDate).toBe('2026/09/19');
      return { status: 200, body: { result: 0, payload: { data: [{
        invNum: 'AA-12345678',
        invDate: { year: '115', month: '9', date: '18' },
        sellerName: '測試商店',
        amount: '120',
      }] } } };
    }
    expect(claim.reqdata.action).toBe('carrierInvDetail');
    expect(claim.reqdata.invNum).toBe('AA-12345678');
    if (options.expired) return { status: 401, body: { message: 'session expired' } };
    return { status: 200, body: { result: 0, payload: { details: [{
      itemName: '豆漿', quantity: '2', unitPrice: '60', amount: '120',
    }] } } };
  });
  return { relayImpl, calls };
}

describe('電子發票唯讀預覽', () => {
  it('登入後讀取兩個期別，點開時才查品項；登入封包不含明文密碼', async () => {
    const { relayImpl, calls } = fakeRelay();
    const preview = await previewEInvoices(connection, credentials, { relayImpl, now });
    expect(preview.periods.map(period => period.invoices.length)).toEqual([1, 0]);
    expect(preview.periods[0].invoices[0]).toMatchObject({
      number: 'AA-12345678', date: '2026-09-18', merchant: '測試商店', amount: 120,
    });
    expect(calls.map(call => call.stage)).toEqual(['login', 'list', 'list']);
    expect(calls[0].payload).not.toContain(credentials.password);
    expect(await preview.loadItems(preview.periods[0].invoices[0])).toEqual([{
      name: '豆漿', quantity: '2', unitPrice: '60', amount: '120',
    }]);
    preview.dispose();
    await expect(preview.loadItems(preview.periods[0].invoices[0])).rejects.toThrow('已結束');
  });

  it('沒有發票時顯示兩個空期別', async () => {
    const { relayImpl } = fakeRelay({ empty: true });
    const preview = await previewEInvoices(connection, credentials, { relayImpl, now });
    expect(preview.periods).toHaveLength(2);
    expect(preview.periods.every(period => !period.invoices.length)).toBe(true);
  });

  it('登入後清單失敗要明確標成讀取階段', async () => {
    const failed = fakeRelay({ listError: true });
    await expect(previewEInvoices(connection, credentials, { relayImpl: failed.relayImpl, now }))
      .rejects.toMatchObject({ stage: 'list' });
    expect(failed.calls.map(call => call.stage)).toEqual(['login', 'list']);
  });

  it('密碼錯誤與工作階段失效不會自行重試', async () => {
    const badLogin = fakeRelay({ loginError: true });
    await expect(previewEInvoices(connection, credentials, { relayImpl: badLogin.relayImpl, now }))
      .rejects.toMatchObject({ stage: 'login' });
    expect(badLogin.calls.map(call => call.stage)).toEqual(['login']);

    const expired = fakeRelay({ expired: true });
    const preview = await previewEInvoices(connection, credentials, { relayImpl: expired.relayImpl, now });
    await expect(preview.loadItems(preview.periods[0].invoices[0])).rejects.toMatchObject({ stage: 'detail' });
    expect(expired.calls.map(call => call.stage)).toEqual(['login', 'list', 'list', 'detail']);
  });

  it('能整理巢狀發票與品項回應，不把資料寫成交易', () => {
    expect(invoiceHeaders({ payload: { data: [{
      invNum: 'BB12345678', invDate: '2026/09/18', sellerName: '商店', amount: '1,200',
    }] } })[0]).toMatchObject({ number: 'BB12345678', amount: 1200 });
    expect(invoiceItems({ payload: { details: [{ description: '牛奶', amount: 45 }] } }))
      .toEqual([{ name: '牛奶', quantity: '', unitPrice: '', amount: '45' }]);
    expect(invoiceHeaders({ payload: { data: [{ sellerName: '缺欄位商店', amount: 10 }] } }))
      .toMatchObject([{ merchant: '缺欄位商店', number: '', date: '', amount: 10 }]);
  });
});
