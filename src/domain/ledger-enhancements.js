import {
  calculateAccountBalances,
  calculateTotalAssets,
  summarizeMonth,
} from './insights.js';

const MAX_RECURRING_RULES = 100;
const MAX_MONTHLY_SNAPSHOTS = 120;
const MAX_RECONCILIATIONS = 200;
const VALID_TYPES = new Set(['expense', 'income', 'transfer']);
const VALID_CADENCES = new Set(['monthly', 'weekly']);

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function safeInteger(value, minimum = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function normalizeRule(value) {
  const type = cleanText(value?.type, 16);
  const amount = safeInteger(value?.amount, 1);
  const account = cleanText(value?.account, 40);
  const startDate = cleanText(value?.startDate, 10);
  const cadence = cleanText(value?.cadence, 16);
  const id = cleanText(value?.id, 80);
  const name = cleanText(value?.name, 120);
  if (!id || !name || !VALID_TYPES.has(type) || !amount || !account || !validDate(startDate) || !VALID_CADENCES.has(cadence)) return null;

  const day = Math.min(31, Math.max(1, safeInteger(value?.day, 1) || 1));
  const toAccount = cleanText(value?.toAccount, 40);
  if (type === 'transfer' && (!toAccount || toAccount === account)) return null;
  const category = cleanText(value?.category, 60);
  if (type !== 'transfer' && !category) return null;
  return {
    id,
    name,
    type,
    amount,
    category: type === 'transfer' ? null : category,
    subcategory: type === 'transfer' ? null : cleanText(value?.subcategory, 60),
    account,
    toAccount: type === 'transfer' ? toAccount : null,
    fee: type === 'transfer' ? safeInteger(value?.fee, 0) || 0 : 0,
    note: cleanText(value?.note, 240),
    cadence,
    day,
    startDate,
    enabled: value?.enabled !== false,
    createdAt: cleanText(value?.createdAt, 40),
  };
}

function normalizeSnapshot(value) {
  const month = cleanText(value?.month, 7);
  const assetTotal = safeInteger(value?.assetTotal, -1_000_000_000_000);
  if (!/^\d{4}-\d{2}$/.test(month) || assetTotal == null) return null;
  const income = safeInteger(value?.income, 0) || 0;
  const expense = safeInteger(value?.expense, 0) || 0;
  const balances = Array.isArray(value?.accountBalances)
    ? value.accountBalances.slice(0, 20).flatMap(item => {
        const id = cleanText(item?.id, 40);
        const balance = safeInteger(item?.balance, -1_000_000_000_000);
        return id && balance != null ? [{ id, balance }] : [];
      })
    : [];
  return { month, assetTotal, income, expense, accountBalances: balances, createdAt: cleanText(value?.createdAt, 40) };
}

function normalizeReconciliation(value) {
  const id = cleanText(value?.id, 80);
  const accountId = cleanText(value?.accountId, 40);
  const actualBalance = safeInteger(value?.actualBalance, -1_000_000_000_000);
  const date = cleanText(value?.date, 10);
  if (!id || !accountId || actualBalance == null || !validDate(date)) return null;
  return { id, accountId, actualBalance, date, note: cleanText(value?.note, 120), createdAt: cleanText(value?.createdAt, 40) };
}

export function normalizeFeatureSettings(value) {
  const recurringRules = Array.isArray(value?.recurringRules)
    ? value.recurringRules.slice(0, MAX_RECURRING_RULES).map(normalizeRule).filter(Boolean)
    : [];
  const monthlySnapshots = Array.isArray(value?.monthlySnapshots)
    ? value.monthlySnapshots.slice(0, MAX_MONTHLY_SNAPSHOTS).map(normalizeSnapshot).filter(Boolean)
    : [];
  const reconciliations = Array.isArray(value?.reconciliations)
    ? value.reconciliations.slice(0, MAX_RECONCILIATIONS).map(normalizeReconciliation).filter(Boolean)
    : [];
  return { recurringRules, monthlySnapshots, reconciliations };
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateText(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dueDates(rule, today) {
  if (!rule.enabled || !validDate(today)) return [];
  const dates = [];
  if (rule.cadence === 'weekly') {
    const cursor = new Date(`${rule.startDate}T00:00:00Z`);
    const end = new Date(`${today}T00:00:00Z`);
    while (cursor <= end && dates.length < 104) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return dates;
  }
  const [startYear, startMonth] = rule.startDate.split('-').map(Number);
  const [endYear, endMonth] = today.split('-').map(Number);
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth); month += 1) {
    if (month > 12) {
      year += 1;
      month = 1;
    }
    const date = dateText(year, month, Math.min(rule.day, lastDayOfMonth(year, month)));
    if (date >= rule.startDate && date <= today) dates.push(date);
  }
  return dates.slice(0, 104);
}

function recurringTransaction(rule, date) {
  return {
    id: `recurring:${rule.id}:${date}`,
    type: rule.type,
    name: rule.name,
    amount: rule.amount,
    category: rule.category,
    subcategory: rule.subcategory,
    account: rule.account,
    toAccount: rule.toAccount,
    ...(rule.fee ? { fee: rule.fee } : {}),
    date,
    note: rule.note,
    source: 'recurring',
    sourceId: `${rule.id}:${date}`,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
  };
}

export function applyRecurringRules(rules, transactions, today) {
  const existing = new Set((transactions || []).map(transaction => transaction?.source === 'recurring' ? transaction.sourceId : ''));
  const created = (rules || []).flatMap(rule => dueDates(rule, today)
    .filter(date => !existing.has(`${rule.id}:${date}`))
    .map(date => recurringTransaction(rule, date)));
  return { created };
}

function normalizedName(value) {
  return cleanText(value, 120).toLocaleLowerCase('zh-Hant').replace(/[\s\p{P}]/gu, '');
}

function median(values) {
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function findTransactionSignals(transactions) {
  const duplicates = new Map();
  const byIdentity = new Map();
  const byCategory = new Map();
  const candidates = (transactions || []).filter(
    transaction => transaction?.type === 'expense' && !transaction?.userEditedAt,
  );
  candidates.forEach(transaction => {
    const identity = [transaction.date, transaction.account, transaction.amount, normalizedName(transaction.name)].join('|');
    const group = byIdentity.get(identity) || [];
    byIdentity.set(identity, [...group, transaction.id]);
    const category = transaction.category || '其他';
    const amounts = byCategory.get(category) || [];
    byCategory.set(category, [...amounts, Number(transaction.amount) || 0]);
  });
  byIdentity.forEach(ids => {
    if (ids.length > 1) ids.forEach(id => duplicates.set(id, '可能重複'));
  });
  const anomalies = new Map();
  const thresholds = new Map([...byCategory].map(([category, amounts]) => [category, Math.max(500, median(amounts) * 3)]));
  candidates.forEach(transaction => {
    if (Number(transaction.amount) > thresholds.get(transaction.category || '其他')) anomalies.set(transaction.id, '金額異常');
  });
  return { duplicates, anomalies };
}

export function createMonthlySnapshot(state, month, createdAt = new Date().toISOString()) {
  const summary = summarizeMonth(state.transactions || [], month);
  const accountBalances = calculateAccountBalances(state.accounts || [], state.transactions || []);
  return {
    month,
    assetTotal: calculateTotalAssets(accountBalances),
    income: summary.income,
    expense: summary.expense,
    accountBalances,
    createdAt,
  };
}

export function reconciliationStatus(estimatedBalance, actualBalance) {
  const difference = Number(actualBalance) - Number(estimatedBalance);
  return {
    estimatedBalance: Number(estimatedBalance) || 0,
    actualBalance: Number(actualBalance) || 0,
    difference,
    status: difference === 0 ? 'matched' : 'mismatch',
  };
}
