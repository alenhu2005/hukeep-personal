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
    featureSettings: remote?.featureSettings
      ? { ...remote.featureSettings }
      : { ...(local?.featureSettings ?? {}) },
  };
}

function transactionIds(values) {
  return Array.isArray(values)
    ? values
        .map(value => String(value ?? '').trim())
        .filter((value, index, all) => value && all.indexOf(value) === index)
    : [];
}

function entityIds(values) {
  return Array.isArray(values)
    ? values
        .map(value => String(value ?? '').trim())
        .filter((value, index, all) => value && all.indexOf(value) === index)
    : [];
}

function transactionChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function updateEntityChanges(current, beforeItems, afterItems, keyOf, upsertField, deleteField) {
  const upserts = new Set(entityIds(current?.[upsertField]));
  const deletes = new Set(entityIds(current?.[deleteField]));
  const before = new Map(
    (Array.isArray(beforeItems) ? beforeItems : [])
      .map(item => [keyOf(item), item])
      .filter(([key]) => key),
  );
  const after = new Map(
    (Array.isArray(afterItems) ? afterItems : [])
      .map(item => [keyOf(item), item])
      .filter(([key]) => key),
  );

  after.forEach((item, key) => {
    if (!before.has(key) || transactionChanged(before.get(key), item)) {
      deletes.delete(key);
      upserts.add(key);
    }
  });
  before.forEach((_item, key) => {
    if (!after.has(key)) {
      upserts.delete(key);
      deletes.add(key);
    }
  });
  return { upserts: [...upserts], deletes: [...deletes] };
}

function reconcileEntities(localItems, remoteItems, pending, keyOf) {
  if (!Array.isArray(remoteItems)) return (Array.isArray(localItems) ? localItems : []).map(item => ({ ...item }));
  const pendingUpserts = new Set(entityIds(pending?.upserts));
  const pendingDeletes = new Set(entityIds(pending?.deletes));
  const localByKey = new Map(
    (Array.isArray(localItems) ? localItems : [])
      .map(item => [keyOf(item), item])
      .filter(([key]) => key),
  );
  const consumed = new Set();
  const result = remoteItems.flatMap(item => {
    const key = keyOf(item);
    if (!key || pendingDeletes.has(key)) return [];
    if (pendingUpserts.has(key) && localByKey.has(key)) {
      consumed.add(key);
      return [{ ...localByKey.get(key) }];
    }
    return [{ ...item }];
  });
  pendingUpserts.forEach(key => {
    if (!consumed.has(key) && localByKey.has(key) && !pendingDeletes.has(key)) {
      result.push({ ...localByKey.get(key) });
    }
  });
  return result;
}

export function hasPendingSheetChanges(value) {
  const coreChanges = [
    value?.upserts,
    value?.deletes,
    value?.accountUpserts,
    value?.accountDeletes,
    value?.budgetUpserts,
    value?.budgetDeletes,
  ].some(items => entityIds(items).length > 0);
  return coreChanges || Boolean(value?.features);
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

  const accounts = updateEntityChanges(
    current,
    beforeState?.accounts,
    afterState?.accounts,
    account => String(account?.id ?? '').trim(),
    'accountUpserts',
    'accountDeletes',
  );
  const budgets = updateEntityChanges(
    current,
    beforeState?.budgets,
    afterState?.budgets,
    budget => String(budget?.category ?? '').trim(),
    'budgetUpserts',
    'budgetDeletes',
  );
  return {
    upserts: [...upserts],
    deletes: [...deletes],
    accountUpserts: accounts.upserts,
    accountDeletes: accounts.deletes,
    budgetUpserts: budgets.upserts,
    budgetDeletes: budgets.deletes,
    features: Boolean(current?.features) || transactionChanged(
      beforeState?.featureSettings ?? {},
      afterState?.featureSettings ?? {},
    ),
  };
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
        ? reconcileEntities(local?.accounts, remote.accounts, {
            upserts: pendingChanges?.accountUpserts,
            deletes: pendingChanges?.accountDeletes,
          }, account => String(account?.id ?? '').trim())
        : (local?.accounts ?? []).map(account => ({ ...account })),
    transactions,
    budgets: reconcileEntities(local?.budgets, remote?.budgets, {
      upserts: pendingChanges?.budgetUpserts,
      deletes: pendingChanges?.budgetDeletes,
    }, budget => String(budget?.category ?? '').trim()),
    preferences: { ...(local?.preferences ?? {}) },
    featureSettings: pendingChanges?.features
      ? { ...(local?.featureSettings ?? {}) }
      : remote?.featureSettings
        ? { ...remote.featureSettings }
        : { ...(local?.featureSettings ?? {}) },
  };
}
