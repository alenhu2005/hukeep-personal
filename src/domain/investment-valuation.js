import { calculateAccountBalances, calculateTotalAssets } from './insights.js';
import { INVESTMENT_ACCOUNT_ID, isInvestmentAccount } from './investment-accounting.js';
import { transactionsAtReconciliation } from './reconciliation.js';

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function investmentMarketValue(state, reconciliation, principal) {
  const actualBalance = reconciliation?.actualBalance;
  if (!Number.isSafeInteger(actualBalance) || actualBalance < 0
    || !Number.isSafeInteger(principal) || !validDate(reconciliation?.date)) return undefined;

  const basis = calculateAccountBalances(
    state.accounts || [],
    transactionsAtReconciliation(state.transactions || [], reconciliation),
  ).find(account => account.id === (reconciliation.accountId || INVESTMENT_ACCOUNT_ID))?.balance;
  const value = actualBalance + principal - basis;
  return Number.isSafeInteger(basis) && Number.isSafeInteger(value) ? Math.max(0, value) : undefined;
}

export function investmentAccountValues(state, through) {
  const transactions = (state.transactions || []).filter(row => !through || row.date <= through);
  const balances = calculateAccountBalances(state.accounts || [], transactions);
  return balances.filter(account => isInvestmentAccount(account.id)).map(account => {
    const checkpoint = (state.featureSettings?.reconciliations || [])
      .filter(item => item.accountId === account.id && (!through || item.date <= through)
        && Number.isSafeInteger(item.actualBalance) && item.actualBalance >= 0 && validDate(item.date))
      .toSorted((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const marketValue = investmentMarketValue({ ...state, transactions }, checkpoint, account.balance);
    return { ...account, principal: account.balance, balance: marketValue ?? account.balance, checkpoint };
  });
}

export function investmentAssetHistory(state, range) {
  return investmentAccountValues(state).map(account => {
    const byDate = new Map();
    (state.featureSettings?.reconciliations || [])
      .filter(item => item.accountId === account.id && validDate(item.date)
        && item.date >= range.from && item.date <= range.to
        && Number.isSafeInteger(item.actualBalance) && item.actualBalance >= 0)
      .toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .forEach(item => byDate.set(item.date, { date: item.date, value: item.actualBalance }));
    const points = [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
    return { ...account, points, change: points.length >= 2 ? points.at(-1).value - points[0].value : null };
  });
}

export function calculateInvestmentValuation(accounts, transactions, marketValue) {
  const balances = calculateAccountBalances(accounts || [], transactions || []);
  const principal = balances.find(account => account.id === INVESTMENT_ACCOUNT_ID)?.balance ?? 0;
  if (!Number.isSafeInteger(principal)) throw new Error('投資本金必須是安全整數');

  const hasMarketValue = marketValue !== undefined && marketValue !== null && marketValue !== '';
  const valuation = hasMarketValue ? Number(marketValue) : principal;
  if (!Number.isSafeInteger(valuation) || valuation < 0) {
    throw new Error('投資市值必須是非負安全整數');
  }

  const totalAssets = calculateTotalAssets(balances.map(account => account.id === INVESTMENT_ACCOUNT_ID
    ? { ...account, balance: valuation }
    : account));
  return { principal, marketValue: hasMarketValue ? valuation : null, totalAssets };
}
