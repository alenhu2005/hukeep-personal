import { getSubcategories } from './category-taxonomy.js';

const VALID_TYPES = new Set(['expense', 'income', 'transfer']);
const VALID_CLASSIFICATION_TYPES = new Set(['expense', 'income']);
const VALID_FEE_MODES = new Set(['included', 'additional']);
const ACCOUNT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/i;
const ENTRY_DRAFT_STORAGE_KEY = 'hukeep_personal_entry_draft_v1';
const DRAFT_FIELDS = {
  name: 120,
  amount: 32,
  type: 16,
  account: 40,
  toAccount: 40,
  category: 60,
  subcategory: 60,
  note: 240,
  fee: 32,
  feeMode: 16,
  date: 10,
  transcript: 2048,
};

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function timestamp(value, fallback) {
  return cleanText(value, 40) || fallback;
}

function safeInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function safeAccount(value, accounts) {
  const account = cleanText(value, 40);
  if (!ACCOUNT_ID_PATTERN.test(account)) return '';
  if (Array.isArray(accounts) && !accounts.some(item => item?.id === account)) return '';
  return account;
}

function validClassification(type, category, subcategory) {
  const subcategories = getSubcategories(category, type);
  return subcategories.length > 0 && (!subcategory || subcategories.includes(subcategory));
}

export function normalizeEntryTemplate(input, options = {}) {
  if (!input || typeof input !== 'object') return null;

  const id = cleanText(input.id, 80);
  const label = cleanText(input.label, 60);
  const name = cleanText(input.name, 120);
  const type = cleanText(input.type, 16);
  const amount = safeInteger(input.amount);
  const account = safeAccount(input.account, options.accounts);
  if (
    !id || !label || !VALID_TYPES.has(type) ||
    amount === null || amount <= 0 || !account
  ) return null;

  const note = cleanText(input.note, 240);
  const now = options.now ?? '';
  if (type === 'transfer') {
    const toAccount = safeAccount(input.toAccount, options.accounts);
    const fee = input.fee == null || input.fee === '' ? 0 : safeInteger(input.fee);
    const feeMode = cleanText(input.feeMode, 16) || 'additional';
    if (
      !toAccount || toAccount === account || fee === null || fee < 0 ||
      !VALID_FEE_MODES.has(feeMode) || (feeMode === 'included' && fee >= amount)
    ) return null;

    const investmentTransfer = account === 'investment' || toAccount === 'investment';
    const category = investmentTransfer ? '投資' : null;
    const subcategory = category && getSubcategories(category).includes(cleanText(input.subcategory, 60))
      ? cleanText(input.subcategory, 60)
      : null;
    return {
      id,
      label,
      name,
      type,
      amount,
      account,
      toAccount,
      category,
      subcategory,
      note,
      fee,
      feeMode,
      createdAt: timestamp(input.createdAt, now),
    };
  }

  const category = cleanText(input.category, 60);
  const subcategory = cleanText(input.subcategory, 60);
  if (!category || !validClassification(type, category, subcategory)) return null;

  return {
    id,
    label,
    name,
    type,
    amount,
    account,
    toAccount: null,
    category,
    subcategory,
    note,
    fee: 0,
    feeMode: null,
    createdAt: timestamp(input.createdAt, now),
  };
}

export function normalizeCategoryRule(input, now = '') {
  if (!input || typeof input !== 'object') return null;

  const id = cleanText(input.id, 80);
  const match = cleanText(input.match, 120);
  const type = cleanText(input.type, 16);
  const category = cleanText(input.category, 60);
  const subcategory = cleanText(input.subcategory, 60);
  if (
    !id || !match || !VALID_CLASSIFICATION_TYPES.has(type) || !category || !subcategory ||
    !validClassification(type, category, subcategory)
  ) return null;

  return {
    id,
    match,
    type,
    category,
    subcategory,
    createdAt: timestamp(input.createdAt, now),
  };
}

function foldMatch(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-Hant');
}

export function matchCategoryRule(transaction, rule) {
  if (!transaction || !rule || transaction.type !== rule.type) return false;
  const match = foldMatch(rule.match);
  return Boolean(match) && [transaction.merchant, transaction.name].some(value => foldMatch(value) === match);
}

function compareCategoryRules(left, right) {
  const leftCreatedAt = cleanText(left.candidate.createdAt, 40);
  const rightCreatedAt = cleanText(right.candidate.createdAt, 40);
  const leftTime = Date.parse(leftCreatedAt);
  const rightTime = Date.parse(rightCreatedAt);
  const leftHasTime = Number.isFinite(leftTime);
  const rightHasTime = Number.isFinite(rightTime);
  if (leftHasTime && rightHasTime && leftTime !== rightTime) return rightTime - leftTime;
  if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;

  const dateOrder = rightCreatedAt < leftCreatedAt ? -1 : rightCreatedAt > leftCreatedAt ? 1 : 0;
  const leftId = left.normalized.id;
  const rightId = right.normalized.id;
  return dateOrder || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
}

export function applyCategoryRules(transaction, rules, now = new Date().toISOString()) {
  if (!transaction || transaction.userEditedAt || !Array.isArray(rules)) return transaction;
  const matches = rules.flatMap(candidate => {
    const normalized = normalizeCategoryRule(candidate);
    return normalized && matchCategoryRule(transaction, normalized) ? [{ candidate, normalized }] : [];
  });
  if (!matches.length) return transaction;
  matches.sort(compareCategoryRules);
  const { normalized } = matches[0];
  return {
    ...transaction,
    category: normalized.category,
    subcategory: normalized.subcategory,
    userEditedAt: now,
    aiStatus: 'confirmed',
  };
}

function normalizeEntryDraft(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const draft = {};
  Object.entries(DRAFT_FIELDS).forEach(([field, maxLength]) => {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      draft[field] = String(fields[field] ?? '').slice(0, maxLength);
    }
  });
  if (Object.prototype.hasOwnProperty.call(fields, 'manualOpen')) {
    draft.manualOpen = fields.manualOpen === true || fields.manualOpen === 'true' || fields.manualOpen === '1';
  }
  return draft;
}

function defaultDraftStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readEntryDraft(storage = defaultDraftStorage()) {
  if (!storage) return null;
  try {
    const saved = storage.getItem(ENTRY_DRAFT_STORAGE_KEY);
    return saved ? normalizeEntryDraft(JSON.parse(saved)) : null;
  } catch {
    return null;
  }
}

export function saveEntryDraft(fields, storage = defaultDraftStorage()) {
  const draft = normalizeEntryDraft(fields);
  if (!draft || !storage) return null;
  try {
    storage.setItem(ENTRY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return draft;
  } catch {
    return null;
  }
}

export function clearEntryDraft(storage = defaultDraftStorage()) {
  if (!storage) return false;
  try {
    storage.removeItem(ENTRY_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
