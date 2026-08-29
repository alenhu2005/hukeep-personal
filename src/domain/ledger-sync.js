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

function transactionIds(values) {
  return Array.isArray(values)
    ? values
        .map(value => String(value ?? '').trim())
        .filter((value, index, all) => value && all.indexOf(value) === index)
    : [];
}

function transactionChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function updatePendingSheetChanges(current, beforeState, afterState) {
  const upserts = new Set(transactionIds(current?.upserts));
  const deletes = new Set(transactionIds(current?.deletes));
  const before = new Map(
    (Array.isArray(beforeState?.transactions) ? beforeState.transactions : []).map(transaction => [
      transaction.id,
      transaction,
    ]),
  );
  const after = new Map(
    (Array.isArray(afterState?.transactions) ? afterState.transactions : []).map(transaction => [
      transaction.id,
      transaction,
    ]),
  );

  after.forEach((transaction, id) => {
    if (!before.has(id) || transactionChanged(before.get(id), transaction)) {
      deletes.delete(id);
      upserts.add(id);
    }
  });
  before.forEach((_transaction, id) => {
    if (!after.has(id)) {
      upserts.delete(id);
      deletes.add(id);
    }
  });

  return { upserts: [...upserts], deletes: [...deletes] };
}

export function reconcileLedgerFromSheet(local, remote, pendingChanges = {}) {
  const localTransactions = Array.isArray(local?.transactions) ? local.transactions : [];
  const remoteTransactions = Array.isArray(remote?.transactions) ? remote.transactions : [];
  const pendingUpserts = new Set(transactionIds(pendingChanges?.upserts));
  const pendingDeletes = new Set(transactionIds(pendingChanges?.deletes));
  const pendingLocalById = new Map(
    localTransactions
      .filter(transaction => pendingUpserts.has(transaction.id))
      .map(transaction => [transaction.id, transaction]),
  );
  const transactions = remoteTransactions.flatMap(transaction => {
    if (pendingDeletes.has(transaction.id)) return [];
    const pendingLocal = pendingLocalById.get(transaction.id);
    if (!pendingLocal) return [{ ...transaction }];
    pendingLocalById.delete(transaction.id);
    return [{ ...pendingLocal }];
  });
  pendingLocalById.forEach(transaction => {
    if (!pendingDeletes.has(transaction.id)) transactions.push({ ...transaction });
  });

  return {
    schemaVersion: 1,
    accounts:
      Array.isArray(remote?.accounts) && remote.accounts.length
        ? remote.accounts.map(account => ({ ...account }))
        : (local?.accounts ?? []).map(account => ({ ...account })),
    transactions,
    budgets: Array.isArray(remote?.budgets)
      ? remote.budgets.map(budget => ({ ...budget }))
      : (local?.budgets ?? []).map(budget => ({ ...budget })),
    preferences: { ...(local?.preferences ?? {}) },
  };
}
