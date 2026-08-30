import { validateClassification } from '../domain/category-taxonomy.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SHEET_ACCOUNTS = 20;
const MAX_SHEET_TRANSACTIONS = 5000;
const MAX_SHEET_BUDGETS = 100;
const MAX_SHEET_AMOUNT = 1_000_000_000_000;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeAiItems(items) {
  const sensitiveLine = /(?:發票(?:號碼|號)|invoice\s*(?:no|number)|^[A-Z]{2}[\s-]?\d{4}[\s-]?\d{4}$)/i;
  const metadataLine = /^(?:date|日期|total|subtotal|tax|總計|合計|小計|稅額|付款金額|交易金額)/i;
  return Array.isArray(items)
    ? items
        .slice(0, 80)
        .map(item => cleanText(item, 160))
        .filter(item => item && !sensitiveLine.test(item) && !metadataLine.test(item))
    : [];
}

export function validateProxyEndpoint(value) {
  let url;
  try {
    url = new URL(cleanText(value, 500));
  } catch {
    throw new Error('代理網址格式不正確');
  }
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
    throw new Error('代理網址必須使用 HTTPS');
  }
  return url.toString();
}

async function postProxy(endpoint, payload, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(validateProxyEndpoint(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new Error(`代理服務暫時無法使用（${response.status}）`);
  const envelope = await response.json();
  if (!envelope?.ok) throw new Error(cleanText(envelope?.error, 200) || '代理服務處理失敗');
  return envelope.data;
}

function normalizePairingCode(value) {
  const code = cleanText(value, 20).normalize('NFKC').toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('手機綁定碼格式不正確');
  return code;
}

export async function createDevicePairingCode(input, options = {}) {
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'createDevicePairingCode',
      proxyToken: cleanText(input?.proxyToken, 300),
    },
    options,
  );
  const code = cleanText(data?.code, 9).toUpperCase();
  const expiresAt = cleanText(data?.expiresAt, 40);
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code) || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('手機綁定碼回傳格式不正確');
  }
  return { code, expiresAt };
}

export async function claimDevicePairingCode(input, options = {}) {
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'claimDeviceBinding',
      code: normalizePairingCode(input?.code),
    },
    options,
  );
  const proxyToken = cleanText(data?.proxyToken, 300);
  if (!proxyToken) throw new Error('手機綁定資料回傳不完整');
  return { proxyToken };
}

export async function classifyExpenseWithAi(input, options = {}) {
  const fallback = input?.fallback;
  const type = input?.type === 'income' ? 'income' : 'expense';
  const data = await postProxy(
    input?.endpoint,
    {
      action: type === 'income' ? 'classifyIncome' : 'classifyExpense',
      proxyToken: cleanText(input?.proxyToken, 300),
      merchant: cleanText(input?.merchant, 120),
      items: sanitizeAiItems(input?.items),
    },
    options,
  );
  if (Number(data?.confidence) <= 0 && fallback) {
    return validateClassification(fallback, { fallback, type });
  }
  return validateClassification(data, { fallback, type });
}

function assertSheetInteger(value, label, options = {}) {
  const amount = Number(value);
  const minimum = options.allowNegative ? -MAX_SHEET_AMOUNT : 0;
  if (!Number.isSafeInteger(amount) || amount < minimum || amount > MAX_SHEET_AMOUNT) {
    throw new Error(`${label}格式不正確`);
  }
  return amount;
}

function projectAccount(account) {
  const id = cleanText(account?.id, 40);
  const name = cleanText(account?.name, 40);
  if (!id || !name) throw new Error('帳戶資料格式不正確');
  return {
    id,
    name,
    openingBalance: assertSheetInteger(account?.openingBalance, `${name}初始金額`, {
      allowNegative: true,
    }),
  };
}

function projectTransaction(transaction) {
  const id = cleanText(transaction?.id, 80);
  const type = cleanText(transaction?.type, 16);
  const account = cleanText(transaction?.account, 40);
  const date = cleanText(transaction?.date, 10);
  if (!id || !['expense', 'income', 'transfer'].includes(type) || !account) {
    throw new Error('交易資料格式不正確');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('交易日期格式不正確');

  const textFields = {
    name: 120,
    category: 60,
    subcategory: 60,
    toAccount: 40,
    note: 240,
    source: 16,
    sourceId: 160,
    invoiceNumber: 20,
    merchant: 120,
    createdAt: 40,
    updatedAt: 40,
    userEditedAt: 40,
    importedAt: 40,
    aiStatus: 24,
    aiReviewedAt: 40,
    rawTranscript: 240,
  };
  const projected = {
    id,
    type,
    amount: assertSheetInteger(transaction?.amount, '交易金額'),
    account,
    toAccount: transaction?.toAccount == null ? null : cleanText(transaction.toAccount, 40),
    date,
  };
  if (type === 'transfer') {
    projected.fee = assertSheetInteger(transaction?.fee ?? 0, '轉帳手續費');
  }
  Object.entries(textFields).forEach(([field, maxLength]) => {
    if (field === 'toAccount') return;
    if (transaction?.[field] != null) projected[field] = cleanText(transaction[field], maxLength);
  });
  if (Array.isArray(transaction?.invoiceItems)) {
    projected.invoiceItems = transaction.invoiceItems
      .slice(0, 80)
      .map(item => cleanText(item, 160))
      .filter(Boolean);
  }
  return projected;
}

function projectBudget(budget) {
  const category = cleanText(budget?.category, 40);
  if (!category) throw new Error('預算資料格式不正確');
  return {
    category,
    limit: assertSheetInteger(budget?.limit, `${category}預算`),
  };
}

export function projectLedgerForSheet(state) {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
  const budgets = Array.isArray(state?.budgets) ? state.budgets : [];
  if (accounts.length > MAX_SHEET_ACCOUNTS) throw new Error('帳戶資料過多');
  if (transactions.length > MAX_SHEET_TRANSACTIONS) throw new Error('交易資料過多');
  if (budgets.length > MAX_SHEET_BUDGETS) throw new Error('預算資料過多');

  return {
    schemaVersion: 1,
    accounts: accounts.map(projectAccount),
    transactions: transactions.map(projectTransaction),
    budgets: budgets.map(projectBudget),
  };
}

function changedKeys(values, maxLength) {
  return Array.isArray(values)
    ? [...new Set(values.map(value => cleanText(value, maxLength)).filter(Boolean))]
    : [];
}

function changedItems(items, keys, keyOf, project) {
  const byKey = new Map(
    (Array.isArray(items) ? items : [])
      .map(item => [keyOf(item), item])
      .filter(([key]) => key),
  );
  return keys.flatMap(key => (byKey.has(key) ? [project(byKey.get(key))] : []));
}

export function projectLedgerChangesForSheet(state, changes) {
  const transactionUpserts = changedKeys(changes?.upserts, 80);
  const transactionDeletes = changedKeys(changes?.deletes, 80);
  const accountUpserts = changedKeys(changes?.accountUpserts, 40);
  const accountDeletes = changedKeys(changes?.accountDeletes, 40);
  const budgetUpserts = changedKeys(changes?.budgetUpserts, 40);
  const budgetDeletes = changedKeys(changes?.budgetDeletes, 40);

  return {
    accounts: changedItems(state?.accounts, accountUpserts, account => cleanText(account?.id, 40), projectAccount),
    accountDeletes,
    transactions: changedItems(state?.transactions, transactionUpserts, transaction => cleanText(transaction?.id, 80), projectTransaction),
    transactionDeletes,
    budgets: changedItems(state?.budgets, budgetUpserts, budget => cleanText(budget?.category, 40), projectBudget),
    budgetDeletes,
  };
}

export async function syncLedgerStateToSheet(input, options = {}) {
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'syncLedgerState',
      proxyToken: cleanText(input?.proxyToken, 300),
      state: projectLedgerForSheet(input?.state),
    },
    options,
  );
  const counts = ['accountCount', 'transactionCount', 'budgetCount'];
  if (!counts.every(field => Number.isInteger(data?.[field]) && data[field] >= 0)) {
    throw new Error('Sheet 同步回傳格式不正確');
  }
  return {
    accountCount: data.accountCount,
    transactionCount: data.transactionCount,
    budgetCount: data.budgetCount,
  };
}

export async function syncLedgerChangesToSheet(input, options = {}) {
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'syncLedgerChanges',
      proxyToken: cleanText(input?.proxyToken, 300),
      changes: projectLedgerChangesForSheet(input?.state, input?.changes),
    },
    options,
  );
  const counts = ['accountCount', 'transactionCount', 'budgetCount'];
  if (!counts.every(field => Number.isInteger(data?.[field]) && data[field] >= 0)) {
    throw new Error('Sheet 自動同步回傳格式不正確');
  }
  return {
    accountCount: data.accountCount,
    transactionCount: data.transactionCount,
    budgetCount: data.budgetCount,
  };
}

function validateDeleteResult(data) {
  if (typeof data?.deleted !== 'boolean') throw new Error('Sheet 刪除回傳格式不正確');
  return { deleted: data.deleted };
}

export async function deleteLedgerTransactionFromSheet(input, options = {}) {
  const transactionId = cleanText(input?.transactionId, 80);
  if (!transactionId) throw new Error('找不到要刪除的交易');
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'deleteLedgerTransaction',
      proxyToken: cleanText(input?.proxyToken, 300),
      transactionId,
    },
    options,
  );
  return validateDeleteResult(data);
}

export async function deleteLedgerBudgetFromSheet(input, options = {}) {
  const category = cleanText(input?.category, 40);
  if (!category) throw new Error('找不到要刪除的預算');
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'deleteLedgerBudget',
      proxyToken: cleanText(input?.proxyToken, 300),
      category,
    },
    options,
  );
  return validateDeleteResult(data);
}

export async function loadLedgerStateFromSheet(input, options = {}) {
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'loadLedgerState',
      proxyToken: cleanText(input?.proxyToken, 300),
    },
    options,
  );
  if (
    data?.schemaVersion !== 1 ||
    !Array.isArray(data.accounts) ||
    !Array.isArray(data.transactions) ||
    !Array.isArray(data.budgets) ||
    data.accounts.length > MAX_SHEET_ACCOUNTS ||
    data.transactions.length > MAX_SHEET_TRANSACTIONS ||
    data.budgets.length > MAX_SHEET_BUDGETS
  ) {
    throw new Error('Sheet 回傳的帳本格式不正確');
  }
  return {
    schemaVersion: 1,
    accounts: data.accounts.map(account => ({ ...account })),
    transactions: data.transactions.map(transaction => ({ ...transaction })),
    budgets: data.budgets.map(budget => ({ ...budget })),
  };
}

function projectSpokenDraft(draft) {
  const type = ['expense', 'income', 'transfer'].includes(draft?.type)
    ? draft.type
    : 'expense';
  const amount = Number(draft?.amount);
  const fee = Number(draft?.fee);
  return {
    type,
    amount: Number.isSafeInteger(amount) && amount > 0 ? amount : null,
    fee: Number.isSafeInteger(fee) && fee >= 0 ? fee : 0,
    category: cleanText(draft?.category, 60),
    subcategory: cleanText(draft?.subcategory, 60),
    account: cleanText(draft?.account, 40),
    toAccount: cleanText(draft?.toAccount, 40),
    date: cleanText(draft?.date, 10),
    name: cleanText(draft?.name, 120),
    note: cleanText(draft?.note, 240),
  };
}

function projectSpokenDrafts(drafts, fallback) {
  const values = Array.isArray(drafts) ? drafts.slice(0, 10) : [];
  const projected = values.map(projectSpokenDraft);
  return projected.length ? projected : [projectSpokenDraft(fallback)];
}

export async function enqueueSpokenEntry(input, options = {}) {
  const transcript = cleanText(input?.transcript, 240).normalize('NFKC');
  if (!transcript) throw new Error('請輸入口語內容');
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'enqueueSpokenEntry',
      proxyToken: cleanText(input?.proxyToken, 300),
      transcript,
      timezone: 'Asia/Taipei',
      draft: projectSpokenDraft(input?.draft),
      drafts: projectSpokenDrafts(input?.drafts, input?.draft),
    },
    options,
  );
  const queueId = cleanText(data?.queueId, 80);
  const status = cleanText(data?.status, 24);
  if (!queueId || !['pending', 'processing', 'reviewed'].includes(status)) {
    throw new Error('口語記帳佇列回傳格式不正確');
  }
  const transactions = (Array.isArray(data?.transactions)
    ? data.transactions
    : data?.transaction && typeof data.transaction === 'object'
      ? [data.transaction]
      : [])
    .filter(transaction => transaction && typeof transaction === 'object')
    .map(transaction => ({ ...transaction }));
  return {
    queueId,
    status,
    transactions,
    transaction: transactions[0] || null,
  };
}
