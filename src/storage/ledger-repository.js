import { normalizeStoredTransaction } from '../domain/transactions.js';

export const STORAGE_KEY = 'hukeep_personal_state_v1';
const VALID_THEMES = new Set(['system', 'light', 'dark']);
const ACCOUNT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/i;

const DEFAULT_ACCOUNTS = [
  { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
  { id: 'line', name: 'LINE', icon: 'L', openingBalance: 0 },
  { id: 'sinopac', name: '永豐', icon: '永', openingBalance: 0 },
  { id: 'bot', name: '台銀', icon: '台', openingBalance: 0 },
  { id: 'post', name: '郵局', icon: '郵', openingBalance: 0 },
];
const LEGACY_ACCOUNT_IDS = new Set(['cash', 'bank', 'card']);

function cleanText(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function normalizeOpeningBalance(value) {
  return Number.isInteger(value) ? value : 0;
}

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) return DEFAULT_ACCOUNTS.map(account => ({ ...account }));

  const seen = new Set();
  const normalized = accounts.flatMap(account => {
    if (!account || typeof account !== 'object') return [];

    const id = cleanText(account.id, 40);
    const name = cleanText(account.name, 40);
    const icon = cleanText(account.icon, 4);
    if (!id || !ACCOUNT_ID_PATTERN.test(id) || !name || !icon || seen.has(id)) return [];

    seen.add(id);
    return [
      {
        id,
        name,
        icon,
        openingBalance: normalizeOpeningBalance(account.openingBalance),
      },
    ];
  });

  return normalized.length ? normalized : DEFAULT_ACCOUNTS.map(account => ({ ...account }));
}

function normalizeBudgets(budgets) {
  if (!Array.isArray(budgets)) return [];

  const seen = new Set();
  return budgets.flatMap(budget => {
    if (!budget || typeof budget !== 'object') return [];

    const category = cleanText(budget.category, 40);
    const limit = Number(budget.limit);
    if (!category || !Number.isInteger(limit) || limit <= 0 || seen.has(category)) return [];

    seen.add(category);
    return [{ category, limit }];
  });
}

function migrateLegacyAccounts(accounts, transactions) {
  const legacy =
    accounts.length === LEGACY_ACCOUNT_IDS.size &&
    accounts.every(account => LEGACY_ACCOUNT_IDS.has(account.id));
  if (!legacy) return { accounts, transactions };

  const legacyById = Object.fromEntries(accounts.map(account => [account.id, account]));
  const openingBalanceById = {
    cash: legacyById.cash?.openingBalance || 0,
    bot: legacyById.bank?.openingBalance || 0,
    sinopac: legacyById.card?.openingBalance || 0,
  };
  const migratedAccounts = DEFAULT_ACCOUNTS.map(account => ({
    ...account,
    openingBalance: openingBalanceById[account.id] || 0,
  }));
  const idMap = { cash: 'cash', bank: 'bot', card: 'sinopac' };
  const migratedTransactions = transactions.map(transaction => ({
    ...transaction,
    account: idMap[transaction.account] || transaction.account,
    toAccount: transaction.toAccount
      ? idMap[transaction.toAccount] || transaction.toAccount
      : null,
  }));
  return { accounts: migratedAccounts, transactions: migratedTransactions };
}

function normalizePreferences(preferences) {
  const theme = cleanText(preferences?.theme, 16);
  const carrierEndpoint = cleanText(preferences?.carrierEndpoint, 500);
  const carrierCardNo = cleanText(preferences?.carrierCardNo, 40);
  const normalized = {
    theme: VALID_THEMES.has(theme) ? theme : 'system',
  };
  try {
    const url = new URL(carrierEndpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) {
      normalized.carrierEndpoint = url.toString();
    }
  } catch {
    // Invalid or absent endpoints are intentionally discarded.
  }
  if (carrierCardNo) normalized.carrierCardNo = carrierCardNo;
  return normalized;
}

export function createEmptyState() {
  return {
    schemaVersion: 1,
    accounts: DEFAULT_ACCOUNTS.map(account => ({ ...account })),
    transactions: [],
    budgets: [],
    preferences: { theme: 'system' },
  };
}

export function normalizeLedgerState(value) {
  const fallback = createEmptyState();
  if (!value || typeof value !== 'object') return fallback;
  const accounts = normalizeAccounts(value.accounts);
  const transactions = Array.isArray(value.transactions)
    ? value.transactions.flatMap(transaction => {
        const normalized = normalizeStoredTransaction(transaction);
        return normalized ? [normalized] : [];
      })
    : [];
  const migrated = migrateLegacyAccounts(accounts, transactions);
  return {
    schemaVersion: 1,
    accounts: migrated.accounts,
    transactions: migrated.transactions,
    budgets: normalizeBudgets(value.budgets),
    preferences: normalizePreferences(value.preferences),
  };
}

export function createLedgerRepository(storage, key = STORAGE_KEY) {
  return {
    load() {
      try {
        const text = storage.getItem(key);
        return text ? normalizeLedgerState(JSON.parse(text)) : createEmptyState();
      } catch {
        return createEmptyState();
      }
    },
    save(state) {
      const normalized = normalizeLedgerState(state);
      storage.setItem(key, JSON.stringify(normalized));
      return normalizeLedgerState(normalized);
    },
    clear() {
      storage.removeItem(key);
    },
  };
}
