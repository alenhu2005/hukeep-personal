export const INVESTMENT_ACCOUNT_ID = 'investment';
export const INVESTMENT_OPENING_ASSET = 12_891;
export const INVESTMENT_ACCOUNT = Object.freeze({
  id: INVESTMENT_ACCOUNT_ID,
  name: '投資資產',
  icon: '投',
  openingBalance: INVESTMENT_OPENING_ASSET,
});

const PRINCIPAL_SUBCATEGORIES = new Set([
  '股票',
  'ETF',
  '基金',
  '債券',
  '加密資產',
  '定期定額',
]);

export function isInvestmentTransfer(transaction) {
  return transaction?.type === 'transfer' &&
    transaction?.category === '投資' &&
    (transaction.account === INVESTMENT_ACCOUNT_ID || transaction.toAccount === INVESTMENT_ACCOUNT_ID);
}

export function investmentDirection(transaction) {
  if (!isInvestmentTransfer(transaction)) return '';
  return transaction.toAccount === INVESTMENT_ACCOUNT_ID ? 'contributed' : 'withdrawn';
}

function canSafelyMigrate(transaction) {
  return transaction?.type === 'expense' &&
    transaction.category === '投資' &&
    PRINCIPAL_SUBCATEGORIES.has(transaction.subcategory) &&
    Number.isInteger(transaction.amount) &&
    transaction.amount > 0 &&
    transaction.account &&
    transaction.account !== INVESTMENT_ACCOUNT_ID;
}

export function migrateInvestmentAccounting(state) {
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
  const accountAdded = !accounts.some(account => account.id === INVESTMENT_ACCOUNT_ID);
  const changedTransactionIds = transactions.filter(canSafelyMigrate).map(transaction => transaction.id);
  const migratedPrincipal = transactions
    .filter(canSafelyMigrate)
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  if (!accountAdded && !changedTransactionIds.length) {
    return { state, changedTransactionIds: [], accountAdded: false };
  }

  const nextAccounts = accountAdded
    ? [
        ...accounts,
        { ...INVESTMENT_ACCOUNT, openingBalance: INVESTMENT_OPENING_ASSET - migratedPrincipal },
      ]
    : accounts.map(account => account.id === INVESTMENT_ACCOUNT_ID
      ? { ...account, openingBalance: (Number(account.openingBalance) || 0) - migratedPrincipal }
      : account);
  const nextTransactions = transactions.map(transaction => canSafelyMigrate(transaction)
    ? {
        ...transaction,
        type: 'transfer',
        toAccount: INVESTMENT_ACCOUNT_ID,
        category: '投資',
      }
    : transaction);

  return {
    state: { ...state, accounts: nextAccounts, transactions: nextTransactions },
    changedTransactionIds,
    accountAdded,
  };
}

export function summarizeInvestmentFlows(transactions) {
  return (transactions || []).reduce((summary, transaction) => {
    const direction = investmentDirection(transaction);
    const amount = Number(transaction?.amount);
    if (!direction || !Number.isInteger(amount) || amount <= 0) return summary;
    const subcategory = transaction.subcategory || '其他投資';
    const signedAmount = direction === 'contributed' ? amount : -amount;
    return {
      contributed: summary.contributed + (direction === 'contributed' ? amount : 0),
      withdrawn: summary.withdrawn + (direction === 'withdrawn' ? amount : 0),
      net: summary.net + signedAmount,
      count: summary.count + 1,
      bySubcategory: {
        ...summary.bySubcategory,
        [subcategory]: (summary.bySubcategory[subcategory] || 0) + signedAmount,
      },
    };
  }, { contributed: 0, withdrawn: 0, net: 0, count: 0, bySubcategory: {} });
}
