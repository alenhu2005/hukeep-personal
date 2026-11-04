import { calculateAccountBalances, calculateTotalAssets } from './insights.js';
import { investmentAccountValues } from './investment-valuation.js';
import { BITO_ACCOUNT, INVESTMENT_ACCOUNT_ID, isInvestmentAccount } from './investment-accounting.js';

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

export function buildAssetHistory(state, range, period = 'month') {
  const start = date(range.from), end = date(range.to);
  if (!start || !end || start > end) return [];
  const cursor = new Date(+start - 86400000);
  const rows = [];
  while (cursor <= end && rows.length < 370) {
    const key = cursor.toISOString().slice(0, 10);
    const opening = cursor < start;
    const tomorrow = new Date(+cursor + 86400000);
    if (period !== 'year' || opening || tomorrow.getUTCMonth() !== cursor.getUTCMonth() || +cursor === +end) {
      const transactions = (state.transactions || []).filter(row => row.date <= key);
      const balances = calculateAccountBalances(state.accounts || [], transactions);
      // Historical values use only checkpoints known by this date, never today's valuation.
      const investments = investmentAccountValues(state, key);
      const liquid = calculateTotalAssets(balances.filter(account => !isInvestmentAccount(account.id)));
      const stocks = investments.find(account => account.id === INVESTMENT_ACCOUNT_ID);
      const label = opening ? '期初' : period === 'year'
        ? `${cursor.getUTCMonth() + 1}月`
        : `${cursor.getUTCMonth() + 1}/${cursor.getUTCDate()}`;
      rows.push({ key, label, longLabel: `${key}${opening ? '（期初）' : '（日終）'}`,
        totalAssets: liquid + calculateTotalAssets(investments), liquid,
        cryptoBalance: investments.find(account => account.id === BITO_ACCOUNT.id)?.balance ?? 0,
        stocks: stocks?.balance ?? null,
        stockValued: Boolean(stocks?.checkpoint),
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}
