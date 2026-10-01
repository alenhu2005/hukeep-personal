import { calculateAccountBalances, isAccountingAdjustment } from './insights.js';

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
    transactions.filter(transaction => transaction.date <= item.date && !excludedIds.has(transaction.id)))
    .find(account => account.id === item.accountId)?.balance ?? 0;
  const difference = item.actualBalance - estimatedBalance;
  const adjustment = matches[0];
  const applied = adjustment ? (adjustment.type === 'income' ? adjustment.amount : -adjustment.amount) : 0;
  return { estimatedBalance, difference, adjustment, corrected: matches.length === 1 && applied === difference };
}

export async function reconciliationAdjustmentId(id) {
  const legacyId = `reconcile-adjust:${id}`;
  if (legacyId.length <= 80) return legacyId;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return `reconcile:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
