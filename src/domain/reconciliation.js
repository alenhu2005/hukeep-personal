import { calculateAccountBalances, isAccountingAdjustment } from './insights.js';

export function transactionsAtReconciliation(transactions, item) {
  const cutoff = Date.parse(item.createdAt);
  const included = new Set(item.includedTransactionIds || []);
  // ponytail: same-day boundary uses creation time; add occurrence times if backdated same-day entries need distinction.
  return transactions.filter(transaction => included.has(transaction.id) || (transaction.date <= item.date
    && (transaction.date !== item.date || !(Date.parse(transaction.createdAt) > cutoff))));
}

export function reconciliationAdjustmentNote(item) {
  return `依 ${item.date} 對帳差額調整 [${item.id}]`;
}

export function reconciliationAdjustmentStatus(state, item) {
  const transactions = state.transactions || [];
  const legacyId = `reconcile-adjust:${item.id}`.slice(0, 80);
  const matches = transactions.filter(transaction => isAccountingAdjustment(transaction)
    && transaction.account === item.accountId && transaction.date === item.date
    && (transaction.note === reconciliationAdjustmentNote(item) || transaction.id === legacyId));
  const excludedIds = new Set(matches.map(transaction => transaction.id));
  const estimatedBalance = calculateAccountBalances(state.accounts,
    transactionsAtReconciliation(transactions, item).filter(transaction => !excludedIds.has(transaction.id)))
    .find(account => account.id === item.accountId)?.balance ?? 0;
  const difference = item.actualBalance - estimatedBalance;
  const adjustment = matches[0];
  const applied = adjustment ? (adjustment.type === 'income' ? adjustment.amount : -adjustment.amount) : 0;
  return { estimatedBalance, difference, adjustment, corrected: matches.length === 1 && applied === difference };
}

export function resolveAlignedReconciliations(state) {
  const items = state.featureSettings?.reconciliations || [];
  if (!items.length) return state;
  const balances = new Map(calculateAccountBalances(state.accounts, state.transactions).map(item => [item.id, item.balance]));
  const latest = new Map();
  items.toSorted((left, right) => String(right.date).localeCompare(String(left.date))
    || String(right.createdAt).localeCompare(String(left.createdAt)))
    .forEach(item => { if (!latest.has(item.accountId)) latest.set(item.accountId, item); });
  let changed = false;
  const reconciliations = items.map(item => {
    if (latest.get(item.accountId) !== item || item.accountId === 'investment'
      || balances.get(item.accountId) !== item.actualBalance) return item;
    const status = reconciliationAdjustmentStatus(state, item);
    if (status.difference === 0 || status.corrected) return item;
    const before = new Set(transactionsAtReconciliation(state.transactions, item).map(transaction => transaction.id));
    const supplements = state.transactions.filter(transaction => !before.has(transaction.id)
      && (transaction.account === item.accountId || (transaction.type === 'transfer' && transaction.toAccount === item.accountId)))
      .map(transaction => transaction.id);
    if (!supplements.length) return item;
    const includedTransactionIds = [...new Set([...(item.includedTransactionIds || []), ...supplements])].toSorted();
    // ponytail: bound supplemental links to 1,000 per checkpoint; larger repairs need a fresh reconciliation.
    if (includedTransactionIds.length > 1000) return item;
    const resolved = { ...item, includedTransactionIds };
    const next = reconciliationAdjustmentStatus(state, resolved);
    if (next.difference !== 0 && !next.corrected) return item;
    changed = true;
    return resolved;
  });
  return changed ? { ...state, featureSettings: { ...state.featureSettings, reconciliations } } : state;
}

export async function reconciliationAdjustmentId(id) {
  const legacyId = `reconcile-adjust:${id}`;
  if (legacyId.length <= 80) return legacyId;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return `reconcile:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
