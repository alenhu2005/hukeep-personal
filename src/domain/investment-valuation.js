import { calculateAccountBalances, calculateTotalAssets } from './insights.js';
import { INVESTMENT_ACCOUNT_ID } from './investment-accounting.js';

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
    (state.transactions || []).filter(transaction => transaction.date <= reconciliation.date),
  ).find(account => account.id === INVESTMENT_ACCOUNT_ID)?.balance;
  const value = actualBalance + principal - basis;
  return Number.isSafeInteger(basis) && Number.isSafeInteger(value) ? Math.max(0, value) : undefined;
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
