import { describe, expect, it } from 'vitest';
import {
  invoiceToTransaction,
  normalizeInvoiceNumber,
  parseReceiptText,
  reconcileImportedTransactions,
} from '../src/domain/imports.js';

function importedTransaction(overrides = {}) {
  return {
    id: 'import-default',
    type: 'expense',
    amount: 120,
    category: '飲食',
    account: 'card',
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
  ])('將常見分隔符、大小寫與全形字正規化：%s', (input, expected) => {
    expect(normalizeInvoiceNumber(input)).toBe(expected);
  });

  it.each(['', null, '12345678', 'ABC12345678', 'AB1234567', 'AB123456789'])(
    '非台灣兩碼英文加八碼數字的號碼不誤判：%s',
    input => {
      expect(normalizeInvoiceNumber(input)).toBeNull();
    },
  );
});

describe('parseReceiptText', () => {
  it('從繁中電子發票 OCR 取得總額、民國年日期、發票號碼與商家', () => {
    const text = [
      '家樂福 桂林店',
      '電子發票證明聯',
      '115年08月28日 18:45',
      '發票號碼：AB-12345678',
      '小計 1,219',
      '稅額 61',
      '總計 NT$ 1,280 元',
    ].join('\n');

    expect(parseReceiptText(text)).toEqual({
      amount: 1280,
      date: '2026-08-28',
      invoiceNumber: 'AB12345678',
      merchant: '家樂福 桂林店',
    });
  });

  it('從英文收據取得 TOTAL，不把 subtotal 或 tax 當總額', () => {
    const text = [
      'STARBUCKS COFFEE',
      'TAX INVOICE',
      'Invoice No. cd 8765 4321',
      'Date: 2026/08/27',
      'Subtotal TWD 150',
      'Tax TWD 15',
      'TOTAL TWD 165',
    ].join('\n');

    expect(parseReceiptText(text)).toEqual({
      amount: 165,
      date: '2026-08-27',
      invoiceNumber: 'CD87654321',
      merchant: 'STARBUCKS COFFEE',
    });
  });

  it('可辨識電子支付截圖常見的付款金額', () => {
    const text = ['LINE Pay', '付款成功', '付款金額 NT$ 320', '2026-08-28 12:30'].join('\n');

    expect(parseReceiptText(text)).toEqual({
      amount: 320,
      date: '2026-08-28',
      invoiceNumber: null,
      merchant: 'LINE Pay',
    });
  });
});

describe('invoiceToTransaction', () => {
  it('建立可追溯回載具發票的支出交易，且不改動輸入', () => {
    const invoice = {
      amount: 1280,
      date: '2026-08-28',
      invoiceNumber: 'ab-12345678',
      merchant: '家樂福 桂林店',
    };

    const transaction = invoiceToTransaction(invoice, {
      source: 'carrier',
      sourceId: 'carrier-row-001',
      id: 'import-001',
      now: '2026-08-28T10:00:00.000Z',
      account: 'card',
      category: '日用',
    });

    expect(transaction).toMatchObject({
      id: 'import-001',
      type: 'expense',
      amount: 1280,
      category: '日用',
      account: 'card',
      toAccount: null,
      date: '2026-08-28',
      note: '家樂福 桂林店',
      source: 'carrier',
      sourceId: 'carrier-row-001',
      invoiceNumber: 'AB12345678',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
    expect(invoice).toEqual({
      amount: 1280,
      date: '2026-08-28',
      invoiceNumber: 'ab-12345678',
      merchant: '家樂福 桂林店',
    });
  });
});

describe('reconcileImportedTransactions', () => {
  it('發票號碼相同必視為重複，即使日期、金額與商家不同', () => {
    const existingOcr = importedTransaction({
      id: 'ocr-existing',
      amount: 120,
      date: '2026-08-28',
      note: '星巴克',
      invoiceNumber: 'ab-12345678',
    });
    const carrierReplacement = importedTransaction({
      id: 'carrier-new',
      amount: 999,
      date: '2026-08-27',
      note: '家樂福',
      source: 'carrier',
      sourceId: 'carrier-row-001',
      invoiceNumber: 'AB12345678',
    });

    const result = reconcileImportedTransactions([existingOcr], [carrierReplacement]);

    expect(result.transactions.map(transaction => transaction.id)).toEqual(['carrier-new']);
    expect(result.removed).toEqual(['ocr-existing']);
    expect(result.replaced).toEqual([
      { removedId: 'ocr-existing', replacementId: 'carrier-new' },
    ]);
  });

  it('無發票號碼時，同日期、同金額且正規化商家相似為高信心重複', () => {
    const existingOcr = importedTransaction({
      id: 'ocr-existing',
      amount: 165,
      note: '星巴克（台北 101 門市）',
    });
    const carrierReplacement = importedTransaction({
      id: 'carrier-new',
      amount: 165,
      note: '星巴克 台北101門市',
      source: 'carrier',
      sourceId: 'carrier-row-002',
      invoiceNumber: 'CD87654321',
    });

    const result = reconcileImportedTransactions([existingOcr], [carrierReplacement]);

    expect(result.transactions.map(transaction => transaction.id)).toEqual(['carrier-new']);
    expect(result.removed).toEqual(['ocr-existing']);
    expect(result.replaced).toEqual([
      { removedId: 'ocr-existing', replacementId: 'carrier-new' },
    ]);
  });

  it('日期與金額相同、但商家只是低信心相似時不自動刪除', () => {
    const existingOcr = importedTransaction({
      id: 'ocr-existing',
      amount: 1490,
      note: '台灣高鐵 台北站',
    });
    const carrierTransaction = importedTransaction({
      id: 'carrier-new',
      amount: 1490,
      note: '台灣鐵路 台北站',
      source: 'carrier',
      sourceId: 'carrier-row-003',
      invoiceNumber: 'EF11223344',
    });

    const result = reconcileImportedTransactions([existingOcr], [carrierTransaction]);

    expect(result.transactions.map(transaction => transaction.id)).toEqual([
      'ocr-existing',
      'carrier-new',
    ]);
    expect(result.removed).toEqual([]);
    expect(result.replaced).toEqual([]);
  });

  it('同一匯入批次也以發票號碼去重，並優先保留載具資料', () => {
    const ocrTransaction = importedTransaction({
      id: 'batch-ocr',
      invoiceNumber: 'GH-55667788',
    });
    const carrierTransaction = importedTransaction({
      id: 'batch-carrier',
      source: 'carrier',
      sourceId: 'carrier-row-004',
      invoiceNumber: 'GH55667788',
    });

    const result = reconcileImportedTransactions([], [ocrTransaction, carrierTransaction]);

    expect(result.transactions.map(transaction => transaction.id)).toEqual(['batch-carrier']);
  });

  it('載具取代 OCR 時保留使用者後來修正的帳戶、備註與分類', () => {
    const editedOcr = importedTransaction({
      id: 'ocr-edited',
      account: 'cash',
      note: '和朋友的生日聚餐',
      category: '人情',
      subcategory: '請客',
      invoiceNumber: 'IJ12345678',
      userEditedAt: '2026-08-28T09:00:00.000Z',
    });
    const carrierReplacement = importedTransaction({
      id: 'carrier-authoritative',
      account: 'card',
      note: '某某餐飲股份有限公司',
      merchant: '某某餐飲股份有限公司',
      category: '飲食',
      subcategory: '聚餐',
      source: 'carrier',
      sourceId: 'carrier-row-edited',
      invoiceNumber: 'IJ12345678',
      invoiceItems: ['雙人套餐'],
    });

    const result = reconcileImportedTransactions([editedOcr], [carrierReplacement]);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      id: 'carrier-authoritative',
      source: 'carrier',
      sourceId: 'carrier-row-edited',
      invoiceItems: ['雙人套餐'],
      merchant: '某某餐飲股份有限公司',
      account: 'cash',
      note: '和朋友的生日聚餐',
      category: '人情',
      subcategory: '請客',
      userEditedAt: '2026-08-28T09:00:00.000Z',
    });
  });

  it('同一匯入批次也會移除無號碼的高信心重複', () => {
    const firstOcr = importedTransaction({
      id: 'batch-ocr-1',
      sourceId: 'screenshot-001',
      amount: 280,
      note: '7-ELEVEN 信義門市',
    });
    const secondOcr = importedTransaction({
      id: 'batch-ocr-2',
      sourceId: 'screenshot-002',
      amount: 280,
      note: '7 ELEVEN信義門市',
    });

    const result = reconcileImportedTransactions([], [firstOcr, secondOcr]);

    expect(result.transactions.map(transaction => transaction.id)).toEqual(['batch-ocr-1']);
  });

  it('對現有與匯入陣列都不做原地修改', () => {
    const existing = [importedTransaction({ id: 'existing' })];
    const incoming = [
      importedTransaction({
        id: 'incoming',
        amount: 880,
        note: '燦坤 3C',
        source: 'carrier',
        sourceId: 'carrier-row-005',
      }),
    ];
    const existingSnapshot = structuredClone(existing);
    const incomingSnapshot = structuredClone(incoming);

    const result = reconcileImportedTransactions(existing, incoming);

    expect(result.transactions).not.toBe(existing);
    expect(existing).toEqual(existingSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });
});
