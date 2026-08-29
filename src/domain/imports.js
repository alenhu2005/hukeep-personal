import { createTransaction } from './transactions.js';

function normalizeWidth(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toUpperCase();
}

export function normalizeInvoiceNumber(value) {
  const compact = normalizeWidth(value).replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{8}$/.test(compact) ? compact : null;
}

function parseReceiptDate(text) {
  const rocMatch = text.match(/(?:民國\s*)?(\d{2,3})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?/);
  const commonMatch = text.match(/(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*日?/);
  const match = commonMatch ?? rocMatch;
  if (!match) return null;
  const rawYear = Number(match[1]);
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseReceiptAmount(lines) {
  const totalPatterns = [/(?:總計|合計|應付(?:金額)?|實付|付款(?:金額)?|交易金額|消費金額)[^\d]*(?:NT\$?|TWD)?\s*([\d,]+)/i, /\bTOTAL\b[^\d]*(?:NT\$?|TWD)?\s*([\d,]+)/i];
  for (const line of lines.toReversed()) {
    if (/subtotal|小計|稅額|tax\b/i.test(line)) continue;
    for (const pattern of totalPatterns) {
      const match = line.match(pattern);
      if (match) return Number(match[1].replaceAll(',', ''));
    }
  }
  return null;
}

function parseMerchant(lines) {
  const ignored = /電子發票|發票證明聯|tax invoice|invoice no|統一編號|日期|date:|小計|總計|total/i;
  return lines.find(line => line.length <= 80 && !ignored.test(line) && /[\p{L}]/u.test(line)) ?? '';
}

export function parseReceiptText(value) {
  const text = String(value ?? '').normalize('NFKC');
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const invoiceMatch = text.match(/[A-Z]{2}[\s-]?\d{4}[\s-]?\d{4}/i);
  return {
    amount: parseReceiptAmount(lines),
    date: parseReceiptDate(text),
    invoiceNumber: normalizeInvoiceNumber(invoiceMatch?.[0]),
    merchant: parseMerchant(lines),
  };
}

export function invoiceToTransaction(invoice, options = {}) {
  const source = options.source === 'carrier' ? 'carrier' : 'ocr';
  const transaction = createTransaction(
    {
      type: 'expense',
      amount: Number(invoice?.amount),
      category: options.category || '其他',
      subcategory: options.subcategory || '其他支出',
      account: options.account || 'cash',
      date: invoice?.date,
      name: String(invoice?.merchant ?? '').trim().slice(0, 120) || '發票消費',
      note: String(invoice?.merchant ?? '').trim().slice(0, 240),
      merchant: invoice?.merchant,
      invoiceNumber: invoice?.invoiceNumber,
      source,
      sourceId: options.sourceId,
      invoiceItems: invoice?.items,
      ocrConfidence: options.ocrConfidence,
    },
    { id: options.id, now: options.now },
  );
  return transaction;
}

function merchantKey(transaction) {
  return String(transaction.merchant || transaction.name || transaction.note || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hant')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function isDuplicate(left, right) {
  const leftInvoice = normalizeInvoiceNumber(left.invoiceNumber);
  const rightInvoice = normalizeInvoiceNumber(right.invoiceNumber);
  if (leftInvoice && rightInvoice) return leftInvoice === rightInvoice;
  if (left.amount !== right.amount || left.date !== right.date) return false;
  const leftMerchant = merchantKey(left);
  const rightMerchant = merchantKey(right);
  return Boolean(leftMerchant && rightMerchant && leftMerchant === rightMerchant);
}

function shouldReplace(existing, incoming) {
  return incoming.source === 'carrier' && existing.source === 'ocr';
}

function mergeReplacement(existing, incoming) {
  const merged = { ...incoming, account: existing.account };
  if (!existing.userEditedAt) return merged;
  return {
    ...merged,
    category: existing.category,
    ...(existing.subcategory ? { subcategory: existing.subcategory } : {}),
    ...(existing.name ? { name: existing.name } : {}),
    note: existing.note,
    userEditedAt: existing.userEditedAt,
  };
}

export function reconcileImportedTransactions(existing, incoming) {
  const transactions = existing.map(transaction => ({ ...transaction }));
  const removed = [];
  const replaced = [];

  for (const candidate of incoming) {
    const duplicateIndex = transactions.findIndex(transaction => isDuplicate(transaction, candidate));
    if (duplicateIndex < 0) {
      transactions.push({ ...candidate });
      continue;
    }

    const duplicate = transactions[duplicateIndex];
    if (!shouldReplace(duplicate, candidate)) continue;
    transactions.splice(duplicateIndex, 1, mergeReplacement(duplicate, candidate));
    removed.push(duplicate.id);
    replaced.push({ removedId: duplicate.id, replacementId: candidate.id });
  }

  return { transactions, removed, replaced };
}
