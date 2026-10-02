import { EXPENSE_TAXONOMY, INCOME_TAXONOMY } from './category-taxonomy.js';
import { isAccountingAdjustment } from './insights.js';
import { ValidationError, updateTransaction } from './transactions.js';

function assertValidAccount(transaction, accounts) {
  const accountIds = new Set(
    (Array.isArray(accounts) ? accounts : []).map(account =>
      typeof account === 'string' ? account : account?.id,
    ),
  );
  if (!accountIds.has(transaction.account)) throw new ValidationError('請選擇有效帳戶');
  if (transaction.type === 'transfer' && !accountIds.has(transaction.toAccount)) {
    throw new ValidationError('請選擇有效的目的帳戶');
  }
}

function assertValidCategory(transaction) {
  if (transaction.type === 'transfer') return;
  if (isAccountingAdjustment(transaction)) return;

  const taxonomy = transaction.refundOf || transaction.type === 'expense'
    ? EXPENSE_TAXONOMY
    : INCOME_TAXONOMY;
  const subcategories = taxonomy[transaction.category];
  if (!subcategories) throw new ValidationError('分類不正確');
  if (transaction.subcategory && !subcategories.includes(transaction.subcategory)) {
    throw new ValidationError('子分類不正確');
  }
}

export function bulkUpdateTransactions(transactions, ids, patch, accounts, options = {}) {
  if (!Array.isArray(transactions) || !Array.isArray(ids) || !ids.length) {
    throw new ValidationError('請選擇要修改的交易');
  }
  if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) {
    throw new ValidationError('請選擇要修改的欄位');
  }
  if (Object.hasOwn(patch, 'refundOf')) {
    throw new ValidationError('請使用退款連結工具修改退款連結');
  }
  if (new Set(ids).size !== ids.length) throw new ValidationError('交易選取重複');

  let updated = transactions;
  for (const id of ids) {
    updated = updateTransaction(updated, id, patch, options);
  }

  for (const id of ids) {
    const transaction = updated.find(item => item.id === id);
    if (['account', 'toAccount', 'type'].some(field => Object.hasOwn(patch, field))) {
      assertValidAccount(transaction, accounts);
    }
    if (['category', 'subcategory', 'type'].some(field => Object.hasOwn(patch, field))) {
      assertValidCategory(transaction);
    }
  }
  return updated;
}

export function linkRefund(transactions, refundId, originalId) {
  if (!originalId) {
    const refund = transactions.find(transaction => transaction.id === refundId);
    if (!refund || refund.type !== 'income') throw new ValidationError('找不到收入退款');
    return updateTransaction(transactions, refundId, {
      refundOf: null,
      category: '退款與理賠',
      subcategory: '消費退款',
    });
  }
  if (refundId === originalId) throw new ValidationError('退款不能連結到原支出');
  const refund = transactions.find(transaction => transaction.id === refundId);
  const original = transactions.find(transaction => transaction.id === originalId);
  if (!refund || !original) throw new ValidationError('找不到退款或原支出');
  if (
    refund.type !== 'income' || !Number.isInteger(refund.amount) || refund.amount <= 0 ||
    isAccountingAdjustment(refund)
  ) {
    throw new ValidationError('退款必須是有效的收入交易');
  }
  if (
    original.type !== 'expense' || !Number.isInteger(original.amount) || original.amount <= 0 ||
    isAccountingAdjustment(original)
  ) {
    throw new ValidationError('退款只能連結到有效的支出交易');
  }
  if (original.date > refund.date) throw new ValidationError('退款日期不能早於原支出日期');

  const linkedRefunds = transactions.filter(transaction => transaction.refundOf === originalId);
  if (linkedRefunds.some(transaction =>
    transaction.id !== refundId && (
      transaction.type !== 'income' || !Number.isInteger(transaction.amount) || transaction.amount <= 0
    ),
  )) {
    throw new ValidationError('已有退款資料不正確');
  }
  const alreadyRefunded = linkedRefunds
    .filter(transaction => transaction.id !== refundId)
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  if (refund.amount > original.amount - alreadyRefunded) {
    throw new ValidationError('退款金額超過原支出剩餘金額');
  }

  return updateTransaction(transactions, refundId, {
    refundOf: originalId,
    category: original.category,
    subcategory: original.subcategory || null,
  });
}
