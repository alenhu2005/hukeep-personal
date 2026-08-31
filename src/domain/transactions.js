export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const VALID_TYPES = new Set(['expense', 'income', 'transfer']);
const VALID_SOURCES = new Set(['manual', 'ocr', 'carrier', 'voice', 'recurring']);
const MAX_ID_LENGTH = 80;
const MAX_TIMESTAMP_LENGTH = 40;

function cleanText(value) {
  return String(value ?? '').trim();
}

function cleanBoundedText(value, maxLength) {
  return cleanText(value).slice(0, maxLength);
}

function assertPositiveInteger(value, label = '金額') {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${label}必須是正整數`);
  }
}

function normalizeTransferFee(value) {
  const fee = value === '' || value == null ? 0 : Number(value);
  if (!Number.isInteger(fee) || fee < 0) {
    throw new ValidationError('手續費必須是零或正整數');
  }
  return fee;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeInput(input) {
  const type = cleanText(input?.type);
  const amount = Number(input?.amount);
  const account = cleanText(input?.account);
  const date = cleanText(input?.date);
  const note = cleanText(input?.note).slice(0, 240);
  const hasName = Object.prototype.hasOwnProperty.call(input ?? {}, 'name');
  const name = cleanBoundedText(input?.name, 120);

  if (!VALID_TYPES.has(type)) throw new ValidationError('交易類型不正確');
  assertPositiveInteger(amount);
  if (!account) throw new ValidationError('請選擇帳戶');
  if (!isValidDate(date)) throw new ValidationError('日期格式不正確');
  if (hasName && !name) throw new ValidationError('請輸入這筆記錄的名稱');
  const identity = hasName ? { name } : {};

  if (type === 'transfer') {
    const toAccount = cleanText(input?.toAccount);
    if (!toAccount || toAccount === account) {
      throw new ValidationError('請選擇不同的目的帳戶');
    }
    const fee = normalizeTransferFee(input?.fee);
    return {
      type,
      amount,
      category: null,
      account,
      toAccount,
      date,
      ...identity,
      note,
      ...(fee ? { fee } : {}),
    };
  }

  const category = cleanText(input?.category);
  if (!category) throw new ValidationError('請選擇分類');
  return { type, amount, category, account, toAccount: null, date, ...identity, note };
}

function normalizeTimestamp(value, fallback) {
  const text = cleanBoundedText(value, MAX_TIMESTAMP_LENGTH);
  return text || fallback;
}

function normalizeInvoiceNumber(value) {
  const compact = cleanText(value)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}\d{8}$/.test(compact) ? compact : '';
}

function normalizeOptionalMetadata(input) {
  const metadata = {};
  const subcategory = cleanBoundedText(input?.subcategory, 60);
  const source = cleanBoundedText(input?.source, 16);
  const sourceId = cleanBoundedText(input?.sourceId, 160);
  const invoiceNumber = normalizeInvoiceNumber(input?.invoiceNumber);
  const merchant = cleanBoundedText(input?.merchant, 120);
  const importedAt = cleanBoundedText(input?.importedAt, MAX_TIMESTAMP_LENGTH);
  const userEditedAt = cleanBoundedText(input?.userEditedAt, MAX_TIMESTAMP_LENGTH);
  const aiStatus = cleanBoundedText(input?.aiStatus, 24);
  const aiReviewedAt = cleanBoundedText(input?.aiReviewedAt, MAX_TIMESTAMP_LENGTH);
  const rawTranscript = cleanBoundedText(input?.rawTranscript, 240);
  const groupId = cleanBoundedText(input?.groupId, 80);
  const receiptId = cleanBoundedText(input?.receiptId, 160);
  const receiptName = cleanBoundedText(input?.receiptName, 160);
  const ocrConfidence = Number(input?.ocrConfidence);

  if (input?.type !== 'transfer' && subcategory) metadata.subcategory = subcategory;
  if (VALID_SOURCES.has(source)) metadata.source = source;
  if (sourceId) metadata.sourceId = sourceId;
  if (invoiceNumber) metadata.invoiceNumber = invoiceNumber;
  if (merchant) metadata.merchant = merchant;
  if (importedAt) metadata.importedAt = importedAt;
  if (userEditedAt) metadata.userEditedAt = userEditedAt;
  if (aiStatus) metadata.aiStatus = aiStatus;
  if (aiReviewedAt) metadata.aiReviewedAt = aiReviewedAt;
  if (rawTranscript) metadata.rawTranscript = rawTranscript;
  if (groupId) metadata.groupId = groupId;
  if (receiptId) metadata.receiptId = receiptId;
  if (receiptName) metadata.receiptName = receiptName;
  if (Array.isArray(input?.aiChanges)) {
    const aiChanges = input.aiChanges
      .slice(0, 12)
      .flatMap(change => {
        const field = cleanBoundedText(change?.field, 40);
        const before = cleanBoundedText(change?.before, 120);
        const after = cleanBoundedText(change?.after, 120);
        return field && before !== after ? [{ field, before, after }] : [];
      });
    if (aiChanges.length) metadata.aiChanges = aiChanges;
  }
  if (Number.isFinite(ocrConfidence)) {
    metadata.ocrConfidence = Math.min(1, Math.max(0, ocrConfidence));
  }
  if (Array.isArray(input?.invoiceItems)) {
    const invoiceItems = input.invoiceItems
      .slice(0, 80)
      .map(item => cleanBoundedText(item, 160))
      .filter(Boolean);
    if (invoiceItems.length) metadata.invoiceItems = invoiceItems;
  }
  return metadata;
}

export function normalizeStoredTransaction(input) {
  if (!input || typeof input !== 'object') return null;

  const id = cleanBoundedText(input.id, MAX_ID_LENGTH);
  if (!id) return null;

  try {
    const normalized = normalizeInput(input);
    const fallbackTimestamp = `${normalized.date}T00:00:00.000Z`;
    const createdAt = normalizeTimestamp(input.createdAt, fallbackTimestamp);
    const updatedAt = normalizeTimestamp(input.updatedAt, createdAt);
    return {
      id,
      ...normalized,
      ...normalizeOptionalMetadata(input),
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function createTransaction(input, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const id = options.id ?? globalThis.crypto?.randomUUID?.() ?? `tx-${Date.now()}`;
  return {
    id,
    ...normalizeInput(input),
    ...normalizeOptionalMetadata(input),
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTransaction(transactions, id, changes, options = {}) {
  const index = transactions.findIndex(transaction => transaction.id === id);
  if (index < 0) throw new ValidationError('找不到要更新的交易');

  const current = transactions[index];
  const normalized = normalizeInput({ ...current, ...changes });
  const updatedAt = options.now ?? new Date().toISOString();
  const currentWithoutFee = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== 'fee'),
  );
  const next = {
    ...currentWithoutFee,
    ...normalized,
    ...normalizeOptionalMetadata({ ...current, ...changes }),
    userEditedAt: updatedAt,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt,
  };
  return transactions.map((transaction, itemIndex) => (itemIndex === index ? next : transaction));
}

export function removeTransaction(transactions, id) {
  return transactions.filter(transaction => transaction.id !== id);
}

export function filterTransactions(transactions, filters = {}) {
  const month = cleanText(filters.month);
  const type = cleanText(filters.type);
  const category = cleanText(filters.category);
  const account = cleanText(filters.account);
  const query = cleanText(filters.query).toLocaleLowerCase('zh-Hant');

  return transactions
    .filter(transaction => !month || transaction.date?.startsWith(month))
    .filter(transaction => !type || transaction.type === type)
    .filter(transaction => !category || transaction.category === category)
    .filter(
      transaction =>
        !account || transaction.account === account || transaction.toAccount === account,
    )
    .filter(transaction => {
      if (!query) return true;
      return [
        transaction.note,
        transaction.name,
        transaction.category,
        transaction.subcategory,
        transaction.merchant,
        transaction.invoiceNumber,
        transaction.account,
        transaction.toAccount,
        transaction.amount,
      ]
        .join(' ')
        .toLocaleLowerCase('zh-Hant')
        .includes(query);
    })
    .toSorted((left, right) => {
      const dateOrder = String(right.date).localeCompare(String(left.date));
      if (dateOrder !== 0) return dateOrder;
      return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
    });
}
