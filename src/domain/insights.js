import { transferAmounts } from './transfer-fees.js';

function inMonth(transaction, month) {
  return transaction?.date?.startsWith(month);
}

function validAmount(transaction) {
  return Number.isInteger(transaction?.amount) && transaction.amount > 0;
}

export function isAccountingAdjustment(transaction) {
  return transaction?.category === '帳務調整' && transaction?.source === 'manual';
}

export function incomeAmount(transaction) {
  if (!validAmount(transaction) || transaction.type !== 'income') return 0;
  if (isAccountingAdjustment(transaction) || transaction.refundOf) return 0;
  return transaction.amount;
}

export function expenseAmount(transaction) {
  if (!validAmount(transaction) || isAccountingAdjustment(transaction)) return 0;
  if (transaction.type === 'expense') return transaction.amount;
  if (transaction.type === 'income' && transaction.refundOf) return -transaction.amount;
  return transaction.type === 'transfer' ? transferAmounts(transaction).fee : 0;
}

export function expenseCategory(transaction) {
  if (transaction?.type === 'transfer') {
    return transaction.category === '投資' ? '投資' : '帳單';
  }
  return transaction?.category || '其他';
}

export function summarizeMonth(transactions, month) {
  const summary = transactions.reduce(
    (result, transaction) => {
      if (!inMonth(transaction, month) || !validAmount(transaction)) return result;
      if (isAccountingAdjustment(transaction)) return result;
      const income = incomeAmount(transaction);
      if (income) {
        return {
          ...result,
          income: result.income + income,
          balance: result.balance + income,
          count: result.count + 1,
        };
      }
      const amount = expenseAmount(transaction);
      if (!amount) return result;
      const category = expenseCategory(transaction);
      return {
        ...result,
        expense: result.expense + amount,
        balance: result.balance - amount,
        count: result.count + 1,
        byCategory: {
          ...result.byCategory,
          [category]: (result.byCategory[category] || 0) + amount,
        },
      };
    },
    { month, income: 0, expense: 0, balance: 0, count: 0, byCategory: {} },
  );
  return summary;
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function buildMonthlyTrend(transactions, endMonth, count = 6) {
  return Array.from({ length: count }, (_, index) => shiftMonth(endMonth, index - count + 1)).map(
    month => {
      const { income, expense, balance } = summarizeMonth(transactions, month);
      return { month, income, expense, balance };
    },
  );
}

export function calculateBudgetProgress(budgets, transactions, month) {
  const { byCategory } = summarizeMonth(transactions, month);
  return budgets.map(budget => {
    const spent = byCategory[budget.category] || 0;
    const remaining = budget.limit - spent;
    const ratio = spent / budget.limit;
    return {
      category: budget.category,
      limit: budget.limit,
      spent,
      remaining,
      ratio,
      status: ratio > 1 ? 'over' : 'ok',
    };
  });
}

export function calculateAccountBalances(accounts, transactions) {
  const balances = Object.fromEntries(
    accounts.map(account => [account.id, Number(account.openingBalance) || 0]),
  );

  for (const transaction of transactions) {
    if (!validAmount(transaction)) continue;
    if (transaction.type === 'income' && transaction.account in balances) {
      balances[transaction.account] += transaction.amount;
    } else if (transaction.type === 'expense' && transaction.account in balances) {
      balances[transaction.account] -= transaction.amount;
    } else if (transaction.type === 'transfer') {
      const { debit, credit } = transferAmounts(transaction);
      if (transaction.account in balances) balances[transaction.account] -= debit;
      if (transaction.toAccount in balances) balances[transaction.toAccount] += credit;
    }
  }

  return accounts.map(account => ({ id: account.id, balance: balances[account.id] }));
}

export function calculateTotalAssets(accountBalances) {
  return accountBalances.reduce((total, account) => {
    const balance = Number(account?.balance);
    return total + (Number.isFinite(balance) ? balance : 0);
  }, 0);
}
