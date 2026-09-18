import { expenseAmount, expenseCategory } from './insights.js';
import { investmentDirection, isInvestmentTransfer, summarizeInvestmentFlows } from './investment-accounting.js';

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

function daysBetween(from, to) {
  const start = dateFromText(from);
  const end = dateFromText(to);
  if (!start || !end) return 0;
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
}

function weekStart(value) {
  const date = dateFromText(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return dateText(date);
}

export function analysisRange(period, selectedMonth, today) {
  const safeToday = dateFromText(today) ? today : dateText(new Date());
  const month = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : safeToday.slice(0, 7);
  if (period === 'week') {
    const from = weekStart(safeToday);
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
  return transactions.reduce((result, transaction) => ({
    income: result.income + (transaction.type === 'income' ? Number(transaction.amount) || 0 : 0),
    expense: result.expense + expenseAmount(transaction),
  }), { income: 0, expense: 0 });
}

function fullPreviousRange(range, period) {
  const to = addDays(range.from, -1);
  if (period === 'week') return { from: addDays(range.from, -7), to };
  if (period === 'year') return { from: `${to.slice(0, 4)}-01-01`, to };
  return { from: `${to.slice(0, 7)}-01`, to };
}

function comparisonRange(range, period, currentDate) {
  const previous = fullPreviousRange(range, period);
  const currentIsIncomplete = dateFromText(currentDate) && currentDate >= range.from && currentDate < range.to;
  if (!currentIsIncomplete) {
    return { ...previous, elapsedDays: daysBetween(range.from, range.to) + 1 };
  }
  const elapsedDays = daysBetween(range.from, currentDate) + 1;
  const matchedTo = addDays(previous.from, elapsedDays - 1);
  return {
    from: previous.from,
    to: matchedTo < previous.to ? matchedTo : previous.to,
    elapsedDays,
  };
}

function amountFor(transaction, type) {
  return type === 'income' && transaction.type === 'income'
    ? Number(transaction.amount) || 0
    : type === 'expense'
      ? expenseAmount(transaction)
      : 0;
}

function percentChange(current, previous) {
  return previous > 0 ? Math.round((current / previous - 1) * 100) : null;
}

function categoryFor(transaction, type) {
  return type === 'income' ? transaction.category || '其他收入' : expenseCategory(transaction);
}

function subcategoryFor(transaction) {
  return transaction.type === 'transfer' ? '轉帳手續費' : transaction.subcategory || '未細分';
}

function categoryGroups(transactions, type, previousTransactions = []) {
  const rows = transactions.filter(row => amountFor(row, type) > 0);
  const previousRows = previousTransactions.filter(row => amountFor(row, type) > 0);
  const total = rows.reduce((sum, row) => sum + amountFor(row, type), 0);
  return [...new Set(rows.map(row => categoryFor(row, type)))].map(category => {
    const members = rows.filter(row => categoryFor(row, type) === category);
    const previousMembers = previousRows.filter(row => categoryFor(row, type) === category);
    const amount = members.reduce((sum, row) => sum + amountFor(row, type), 0);
    const previousAmount = previousMembers.reduce((sum, row) => sum + amountFor(row, type), 0);
    const children = [...new Set(members.map(subcategoryFor))].map(subcategory => {
      const childTransactions = members.filter(row => subcategoryFor(row) === subcategory);
      const previousChildTransactions = previousMembers.filter(row => subcategoryFor(row) === subcategory);
      const subtotal = childTransactions.reduce((sum, row) => sum + amountFor(row, type), 0);
      const previousSubtotal = previousChildTransactions.reduce((sum, row) => sum + amountFor(row, type), 0);
      return {
        subcategory,
        amount: subtotal,
        count: childTransactions.length,
        average: childTransactions.length ? Math.round(subtotal / childTransactions.length) : 0,
        percent: amount ? Math.round(subtotal / amount * 100) : 0,
        previousAmount: previousSubtotal,
        changePercent: percentChange(subtotal, previousSubtotal),
        transactions: childTransactions,
      };
    }).toSorted((a, b) => b.amount - a.amount || a.subcategory.localeCompare(b.subcategory));
    return {
      category,
      amount,
      count: members.length,
      average: members.length ? Math.round(amount / members.length) : 0,
      percent: total ? Math.round(amount / total * 100) : 0,
      previousAmount,
      changePercent: percentChange(amount, previousAmount),
      transactions: members,
      children,
    };
  }).toSorted((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
}

function rangeKeys(range, period) {
  if (period === 'year') {
    return Array.from({ length: 12 }, (_, index) => `${range.from.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`);
  }
  return Array.from({ length: Math.max(0, daysBetween(range.from, range.to) + 1) }, (_, index) => addDays(range.from, index));
}

function timeSeries(transactions, type, range, period) {
  return rangeKeys(range, period).map(key => {
    const amount = transactions
      .filter(row => period === 'year' ? row.date?.slice(0, 7) === key : row.date === key)
      .reduce((sum, row) => sum + amountFor(row, type), 0);
    return {
      key,
      label: period === 'year'
        ? `${Number(key.slice(5))}月`
        : `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`,
      amount,
    };
  });
}

function accountGroups(transactions, type) {
  const valid = transactions.filter(row => amountFor(row, type) > 0);
  const total = valid.reduce((sum, row) => sum + amountFor(row, type), 0);
  return [...new Set(valid.map(row => row.account || '未指定'))].map(account => {
    const members = valid.filter(row => (row.account || '未指定') === account);
    const amount = members.reduce((sum, row) => sum + amountFor(row, type), 0);
    return {
      account,
      amount,
      count: members.length,
      percent: total ? Math.round(amount / total * 100) : 0,
    };
  }).toSorted((left, right) => right.amount - left.amount || left.account.localeCompare(right.account));
}

function buildFocus(groups, type, category, subcategory, range, period) {
  const group = groups.find(row => row.category === category);
  if (!group) return null;
  const child = subcategory ? group.children.find(row => row.subcategory === subcategory) : null;
  const selected = child || group;
  return {
    type,
    category: group.category,
    subcategory: child?.subcategory || '',
    amount: selected.amount,
    count: selected.count,
    average: selected.average,
    percent: selected.percent,
    previousAmount: selected.previousAmount,
    changePercent: selected.changePercent,
    transactions: selected.transactions,
    children: group.children,
    timeSeries: timeSeries(selected.transactions, type, range, period),
    accounts: accountGroups(selected.transactions, type),
  };
}

function investmentSeries(transactions, range, period) {
  return rangeKeys(range, period).map(key => {
    const members = transactions.filter(row => period === 'year' ? row.date?.slice(0, 7) === key : row.date === key);
    const flow = summarizeInvestmentFlows(members);
    return {
      key,
      label: period === 'year' ? `${Number(key.slice(5))}月` : `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`,
      contributed: flow.contributed,
      withdrawn: flow.withdrawn,
      net: flow.net,
    };
  });
}

export function buildAnalysisWorkspace(transactions, options = {}) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const period = ['week', 'month', 'year'].includes(options.period) ? options.period : 'month';
  const range = analysisRange(period, options.selectedMonth, options.today);
  const scoped = rows.filter(transaction => inRange(transaction, range));
  const expenseTransactions = scoped.filter(transaction => expenseAmount(transaction) > 0);
  const totalsNow = totals(scoped);
  const previousComparison = comparisonRange(range, period, options.currentDate);
  const previousRange = { from: previousComparison.from, to: previousComparison.to };
  const previousScoped = rows.filter(transaction => inRange(transaction, previousRange));
  const previousTotals = totals(previousScoped);
  const expenseGroups = categoryGroups(scoped, 'expense', previousScoped);
  const incomeGroups = categoryGroups(scoped, 'income', previousScoped);
  const categoryRows = expenseGroups.map(({ category, amount, percent }) => ({ category, amount, percent }));
  const dailyRows = Object.entries(
    expenseTransactions.reduce((result, transaction) => ({
      ...result,
      [transaction.date]: (result[transaction.date] || 0) + expenseAmount(transaction),
    }), {}),
  )
    .map(([date, amount]) => ({ date, amount }))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const monthRows = period === 'year'
    ? rangeKeys(range, period).map(month => {
        const members = scoped.filter(transaction => transaction.date?.slice(0, 7) === month);
        const monthTotals = totals(members);
        return { month, amount: monthTotals.expense, income: monthTotals.income, net: monthTotals.income - monthTotals.expense };
      })
    : [];
  const largest = expenseTransactions
    .map(transaction => ({ name: transaction.name, amount: expenseAmount(transaction), date: transaction.date }))
    .toSorted((left, right) => right.amount - left.amount)[0] || null;
  const top = categoryRows[0] || null;
  const change = percentChange(totalsNow.expense, previousTotals.expense);
  const insights = [
    top ? { label: '支出重心', value: `${top.category} ${top.percent}%` } : { label: '支出重心', value: '尚無支出' },
    change == null ? { label: '較前期', value: '尚無可比較資料' } : { label: '較前期', value: `${change > 0 ? '+' : ''}${change}%` },
    largest ? { label: '最大單筆', value: `${largest.name || '未命名'} · ${largest.amount}` } : { label: '最大單筆', value: '尚無資料' },
  ];
  const incomeLargest = scoped.filter(row => row.type === 'income').toSorted((a, b) => b.amount - a.amount)[0];
  const incomeChange = percentChange(totalsNow.income, previousTotals.income);
  const incomeInsights = [
    { label: '主要來源', value: incomeGroups.length ? `${incomeGroups[0].category} ${incomeGroups[0].percent}%` : '尚無收入' },
    { label: '較前期', value: incomeChange == null ? '尚無可比較資料' : `${incomeChange > 0 ? '+' : ''}${incomeChange}%` },
    { label: '最大單筆', value: incomeLargest ? `${incomeLargest.name || '未命名'} · ${incomeLargest.amount}` : '尚無資料' },
  ];
  const investmentFlows = summarizeInvestmentFlows(scoped);
  const investmentGroups = Object.keys(investmentFlows.bySubcategory)
    .map(subcategory => {
      const members = scoped.filter(transaction =>
        investmentDirection(transaction) && (transaction.subcategory || '其他投資') === subcategory);
      const contributed = members
        .filter(transaction => investmentDirection(transaction) === 'contributed')
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      const withdrawn = members
        .filter(transaction => investmentDirection(transaction) === 'withdrawn')
        .reduce((sum, transaction) => sum + transaction.amount, 0);
      return { subcategory, contributed, withdrawn, net: contributed - withdrawn, count: members.length };
    })
    .toSorted((left, right) => Math.abs(right.net) - Math.abs(left.net) || left.subcategory.localeCompare(right.subcategory));
  const selectedDate = options.selectedDate >= range.from && options.selectedDate <= range.to
    ? options.selectedDate
    : '';
  const selectedDayTransactions = selectedDate ? scoped.filter(transaction => transaction.date === selectedDate) : [];
  const selectedDayTotals = totals(selectedDayTransactions);
  const selectedDay = selectedDate
    ? {
        date: selectedDate,
        transactions: selectedDayTransactions,
        totals: selectedDayTotals,
        balance: selectedDayTotals.income - selectedDayTotals.expense,
        investmentFlows: summarizeInvestmentFlows(selectedDayTransactions),
      }
    : null;
  const focusType = options.section === 'income' ? 'income' : 'expense';
  const focusGroups = focusType === 'income' ? incomeGroups : expenseGroups;
  const focus = buildFocus(focusGroups, focusType, options.category, options.subcategory, range, period);
  const investmentIncome = incomeGroups.find(group => group.category === '投資') || null;
  const investmentCostTransactions = expenseTransactions.filter(row => row.category === '投資' || isInvestmentTransfer(row));
  const investmentCost = investmentCostTransactions.reduce((sum, row) => sum + expenseAmount(row), 0);
  return {
    incomeGroups,
    expenseGroups,
    incomeInsights,
    investmentFlows,
    investmentGroups,
    investmentSeries: investmentSeries(scoped, range, period),
    investmentIncome,
    investmentCost,
    investmentCostTransactions,
    range,
    scoped,
    expenseTransactions,
    totals: totalsNow,
    previousTotals,
    comparison: {
      range: previousRange,
      elapsedDays: previousComparison.elapsedDays,
      balance: previousTotals.income - previousTotals.expense,
      savingsRate: previousTotals.income
        ? Math.round(((previousTotals.income - previousTotals.expense) / previousTotals.income) * 100)
        : null,
    },
    balance: totalsNow.income - totalsNow.expense,
    savingsRate: totalsNow.income
      ? Math.round(((totalsNow.income - totalsNow.expense) / totalsNow.income) * 100)
      : null,
    selectedDay,
    focus,
    categoryRows,
    dailyRows,
    monthRows,
    largest,
    insights,
  };
}
