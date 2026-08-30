import { describe, expect, it } from 'vitest';
import {
  invoiceToTransaction,
  normalizeInvoiceNumber,
  parseReceiptText,
  reconcileImportedTransactions,
} from '../src/domain/imports.js';

function ocrTransaction(overrides = {}) {
  return {
    id: 'ocr-default',
    type: 'expense',
    amount: 120,
    category: '飲食',
    subcategory: '咖啡',
    account: 'sinopac',
    toAccount: null,
    date: '2026-08-28',
    note: '星巴克 台北 101 門市',
    source: 'ocr',
    sourceId: 'screenshot-default',
    invoiceNumber: null,
    createdAt: '2026-08-28T08:00:00.000Z',
    updatedAt: '2026-08-28T08:00:00.000Z',
    ...overrides,
  };
}

describe('normalizeInvoiceNumber', () => {
  it.each([
    [' ab-12345678 ', 'AB12345678'],
    ['AB 1234 5678', 'AB12345678'],
    ['ａｂ－１２３４５６７８', 'AB12345678'],
  ])('正規化常見發票號碼：%s', (input, expected) => {
    expect(normalizeInvoiceNumber(input)).toBe(expected);
  });

  it.each(['', null, '12345678', 'ABC12345678'])('不誤判無效號碼：%s', input => {
    expect(normalizeInvoiceNumber(input)).toBeNull();
  });
});

describe('parseReceiptText', () => {
  it('從繁中電子發票 OCR 取得總額、民國年日期、發票號碼與商家', () => {
    const text = [
      '家樂福 桂林店', '電子發票證明聯', '115年08月28日 18:45',
      '發票號碼：AB-12345678', '小計 1,219', '稅額 61', '總計 NT$ 1,280 元',
    ].join('\n');

    expect(parseReceiptText(text)).toEqual({
      amount: 1280,
      date: '2026-08-28',
      invoiceNumber: 'AB12345678',
      merchant: '家樂福 桂林店',
    });
  });

  it('從付款截圖取得金額與日期', () => {
    expect(parseReceiptText('LINE Pay\n付款成功\n付款金額 NT$ 320\n2026-08-28 12:30')).toEqual({
      amount: 320,
      date: '2026-08-28',
      invoiceNumber: null,
      merchant: 'LINE Pay',
    });
  });

  it('遇到無效日期或找不到總額時，不猜測錯誤的金額與日期', () => {
    expect(parseReceiptText('測試商店\n2026-02-30\n小計 120')).toMatchObject({
      amount: null,
      date: null,
      merchant: '測試商店',
    });
  });
});

describe('invoiceToTransaction', () => {
  it('OCR 草稿永遠建立為 ocr 來源，且不改動輸入', () => {
    const invoice = { amount: 1280, date: '2026-08-28', invoiceNumber: 'ab-12345678', merchant: '家樂福 桂林店' };
    const transaction = invoiceToTransaction(invoice, {
      sourceId: 'screenshot-001', id: 'ocr-001', now: '2026-08-28T10:00:00.000Z',
      account: 'sinopac', category: '購物', subcategory: '日用品',
    });

    expect(transaction).toMatchObject({
      id: 'ocr-001', source: 'ocr', sourceId: 'screenshot-001', invoiceNumber: 'AB12345678',
      amount: 1280, category: '購物', subcategory: '日用品', account: 'sinopac',
    });
    expect(invoice.invoiceNumber).toBe('ab-12345678');
  });
});

describe('reconcileImportedTransactions', () => {
  it('發票號碼相同必視為重複，保留先前 OCR 記錄', () => {
    const existing = ocrTransaction({ id: 'ocr-existing', invoiceNumber: 'AB12345678' });
    const incoming = ocrTransaction({ id: 'ocr-new', invoiceNumber: 'ab-12345678', amount: 999 });

    expect(reconcileImportedTransactions([existing], [incoming])).toMatchObject({
      transactions: [existing], removed: [], replaced: [],
    });
  });

  it('相同日期、金額與商家會去重，不改動輸入陣列', () => {
    const existing = [ocrTransaction({ id: 'ocr-1', amount: 280, note: '7-ELEVEN 信義門市' })];
    const incoming = [ocrTransaction({ id: 'ocr-2', amount: 280, note: '7 ELEVEN信義門市' })];
    const existingSnapshot = structuredClone(existing);
    const incomingSnapshot = structuredClone(incoming);

    const result = reconcileImportedTransactions(existing, incoming);

    expect(result.transactions.map(transaction => transaction.id)).toEqual(['ocr-1']);
    expect(existing).toEqual(existingSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });

  it('找不到重複項目時加入新的 OCR 記錄', () => {
    const incoming = ocrTransaction({ id: 'ocr-new', amount: 350, date: '2026-08-29' });

    const result = reconcileImportedTransactions([], [incoming]);

    expect(result).toMatchObject({
      transactions: [incoming],
      removed: [],
      replaced: [],
    });
    expect(result.transactions[0]).not.toBe(incoming);
  });
});
