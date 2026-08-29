function timestamp(value) {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : '';
}

function newerTransaction(local, remote) {
  const localUpdatedAt = timestamp(local?.updatedAt);
  const remoteUpdatedAt = timestamp(remote?.updatedAt);
  if (local?.userEditedAt && localUpdatedAt >= remoteUpdatedAt) return local;
  return remoteUpdatedAt > localUpdatedAt ? remote : local;
}

export function mergeLedgerStates(local, remote) {
  const localTransactions = Array.isArray(local?.transactions) ? local.transactions : [];
  const remoteTransactions = Array.isArray(remote?.transactions) ? remote.transactions : [];
  const remoteById = new Map(remoteTransactions.map(transaction => [transaction.id, transaction]));
  const mergedTransactions = localTransactions.map(transaction => {
    const remoteTransaction = remoteById.get(transaction.id);
    if (!remoteTransaction) return transaction;
    remoteById.delete(transaction.id);
    return newerTransaction(transaction, remoteTransaction);
  });

  return {
    schemaVersion: 1,
    accounts:
      Array.isArray(remote?.accounts) && remote.accounts.length
        ? remote.accounts.map(account => ({ ...account }))
        : (local?.accounts ?? []).map(account => ({ ...account })),
    transactions: [
      ...mergedTransactions.map(transaction => ({ ...transaction })),
      ...[...remoteById.values()].map(transaction => ({ ...transaction })),
    ],
    budgets: Array.isArray(remote?.budgets)
      ? remote.budgets.map(budget => ({ ...budget }))
      : (local?.budgets ?? []).map(budget => ({ ...budget })),
    preferences: { ...(local?.preferences ?? {}) },
  };
}
