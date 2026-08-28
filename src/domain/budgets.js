function normalizeBudget(input) {
  const category = String(input?.category ?? '').trim();
  const limit = Number(input?.limit);
  if (!category) throw new Error('請選擇預算分類');
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('預算必須是正整數');
  return { category, limit };
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
