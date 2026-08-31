function dateFromText(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))
    ? new Date(`${value}T00:00:00Z`)
    : null;
}

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return dateText(new Date(Date.UTC(year, monthNumber, 0)));
}

function addDays(value, days) {
  const date = dateFromText(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return dateText(date);
}

function weekStart(value) {
  const date = dateFromText(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return dateText(date);
}

export function analysisRange(period, selectedMonth, today) {
  const month = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : today.slice(0, 7);
  if (period === 'week') {
    const from = weekStart(today);
    const to = addDays(from, 6);
    return { from, to, label: `${from.slice(5).replace('-', '/')}～${to.slice(5).replace('-', '/')}` };
  }
  if (period === 'year') {
    const year = month.slice(0, 4);
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: `${year} 年` };
  }
  return { from: `${month}-01`, to: monthEnd(month), label: month };
}

function inRange(transaction, range) {
  return transaction?.date >= range.from && transaction.date <= range.to;
}

function totals(transactions) {
  return transactions.reduce((result, transaction) => {
    const amount = Number(transaction.amount) || 0;
    if (transaction.type === 'income') result.income += amount;
    if (transaction.type === 'expense') result.expense += amount;
    return result;
  }, { income: 0, expense: 0 });
}

function compareRange(range) {
  const days = Math.max(1, Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1);
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

export function buildAnalysisWorkspace(transactions, options) {
  const period = options?.period;
  const range = analysisRange(period, options?.selectedMonth, options?.today);
  const scoped = (transactions || []).filter(transaction => inRange(transaction, range));
  const expenseTransactions = scoped.filter(transaction => transaction.type === 'expense');
  const totalsNow = totals(scoped);
  const previousTotals = totals((transactions || []).filter(transaction => inRange(transaction, compareRange(range))));
  const categoryRows = Object.entries(
    expenseTransactions.reduce((result, transaction) => {
      const category = transaction.category || '其他';
      result[category] = (result[category] || 0) + (Number(transaction.amount) || 0);
      return result;
    }, {}),
  )
    .map(([category, amount]) => ({
      category,
      amount,
      percent: totalsNow.expense ? Math.round((amount / totalsNow.expense) * 100) : 0,
    }))
    .toSorted((left, right) => right.amount - left.amount || left.category.localeCompare(right.category));
  const dailyRows = Object.entries(
    expenseTransactions.reduce((result, transaction) => {
      result[transaction.date] = (result[transaction.date] || 0) + (Number(transaction.amount) || 0);
      return result;
    }, {}),
  )
    .map(([date, amount]) => ({ date, amount }))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const monthRows = period === 'year'
    ? Array.from({ length: 12 }, (_, index) => {
        const month = `${range.from.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
        return {
          month,
          amount: expenseTransactions
            .filter(transaction => transaction.date.slice(0, 7) === month)
            .reduce((sum, transaction) => sum + (Number(transaction.amount) || 0), 0),
        };
      })
    : [];
  const largest = expenseTransactions
    .map(transaction => ({ name: transaction.name, amount: Number(transaction.amount) || 0, date: transaction.date }))
    .toSorted((left, right) => right.amount - left.amount)[0] || null;
  const top = categoryRows[0] || null;
  const change = previousTotals.expense
    ? Math.round(((totalsNow.expense - previousTotals.expense) / previousTotals.expense) * 100)
    : null;
  const insights = [
    top ? { label: '支出重心', value: `${top.category} ${top.percent}%` } : { label: '支出重心', value: '尚無支出' },
    change == null ? { label: '較前期', value: '尚無可比較資料' } : { label: '較前期', value: `${change > 0 ? '+' : ''}${change}%` },
    largest ? { label: '最大單筆', value: `${largest.name || '未命名'} · ${largest.amount}` } : { label: '最大單筆', value: '尚無資料' },
  ];
  return {
    range,
    scoped,
    expenseTransactions,
    totals: totalsNow,
    previousTotals,
    categoryRows,
    dailyRows,
    monthRows,
    largest,
    insights,
  };
}
