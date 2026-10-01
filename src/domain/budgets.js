import { summarizeMonth } from './insights.js';

function normalizeBudget(input) {
  const category = String(input?.category ?? '').trim();
  const limit = Number(input?.limit);
  if (!category) throw new Error('請選擇預算分類');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('預算必須是正整數');
  return { category, limit };
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function forecastBudgetProgress(budgets, transactions, month, today) {
  const canForecast = validMonth(month) && validDate(today) && today.slice(0, 7) === month;
  const [year, monthNumber] = canForecast ? month.split('-').map(Number) : [];
  const daysInMonth = canForecast ? new Date(Date.UTC(year, monthNumber, 0)).getUTCDate() : 0;
  const daysObserved = canForecast ? Number(today.slice(8, 10)) : 0;
  const { expense, byCategory } = summarizeMonth(transactions || [], month);
  const enoughData = canForecast && daysObserved >= 7 && expense > 0;

  return (budgets || []).map(budget => {
    const spent = byCategory[budget.category] || 0;
    const expectedExpense = enoughData && spent > 0
      ? Math.round(spent / daysObserved * daysInMonth)
      : null;
    return {
      category: budget.category,
      limit: budget.limit,
      spent,
      expectedExpense,
      expectedOverage: expectedExpense == null ? null : Math.max(0, expectedExpense - budget.limit),
    };
  });
}

export function upsertBudget(budgets, input) {
  const nextBudget = normalizeBudget(input);
  const exists = budgets.some(budget => budget.category === nextBudget.category);
  if (!exists) return [...budgets, nextBudget];
  return budgets.map(budget =>
    budget.category === nextBudget.category ? nextBudget : budget,
  );
}

export function removeBudget(budgets, category) {
  return budgets.filter(budget => budget.category !== category);
}
