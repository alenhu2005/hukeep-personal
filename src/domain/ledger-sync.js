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

const FEATURE_KEYS = {
  recurringRules: item => item?.id,
  monthlySnapshots: item => item?.month,
  reconciliations: item => item?.id,
};

function mergeConcurrentItems(baseItems, intendedItems, latestItems, keyOf) {
  const changes = updateEntityChanges({}, baseItems, intendedItems, keyOf, 'upserts', 'deletes');
  return reconcileEntities(intendedItems, latestItems, changes, keyOf);
}

function mergeConcurrentPreferences(base, intended, latest) {
  const result = { ...(latest ?? {}) };
  const basePreferences = base ?? {};
  const intendedPreferences = intended ?? {};
  new Set([...Object.keys(basePreferences), ...Object.keys(intendedPreferences)]).forEach(key => {
    const hadBase = Object.prototype.hasOwnProperty.call(basePreferences, key);
    const hasIntended = Object.prototype.hasOwnProperty.call(intendedPreferences, key);
    if (!hasIntended && hadBase) delete result[key];
    else if (hasIntended && (!hadBase || transactionChanged(basePreferences[key], intendedPreferences[key]))) {
      result[key] = intendedPreferences[key];
    }
  });
  return result;
}

export function mergeConcurrentLedgerState(baseState, intendedState, latestStoredState) {
  const base = baseState ?? {};
  const intended = intendedState ?? {};
  const latest = latestStoredState ?? {};
  const merged = { ...latest };
  merged.transactions = mergeConcurrentItems(base.transactions, intended.transactions,
    Array.isArray(latest.transactions) ? latest.transactions : [], item => String(item?.id ?? '').trim());
  merged.accounts = mergeConcurrentItems(base.accounts, intended.accounts,
    Array.isArray(latest.accounts) ? latest.accounts : [], item => String(item?.id ?? '').trim());
  merged.budgets = mergeConcurrentItems(base.budgets, intended.budgets,
    Array.isArray(latest.budgets) ? latest.budgets : [], item => String(item?.category ?? '').trim());
  merged.preferences = mergeConcurrentPreferences(base.preferences, intended.preferences, latest.preferences);
  merged.featureSettings = { ...(latest.featureSettings ?? {}) };
  Object.entries(FEATURE_KEYS).forEach(([collection, keyOf]) => {
    merged.featureSettings[collection] = mergeConcurrentItems(
      base.featureSettings?.[collection],
      intended.featureSettings?.[collection],
      Array.isArray(latest.featureSettings?.[collection]) ? latest.featureSettings[collection] : [],
      item => String(keyOf(item) ?? '').trim(),
    );
  });
  return merged;
}

function featureChanges(before, after, current = {}) {
  const upserts = { ...(current.upserts ?? {}) };
  const deletes = { ...(current.deletes ?? {}) };
  Object.entries(FEATURE_KEYS).forEach(([collection, keyOf]) => {
    const oldItems = new Map((before?.[collection] ?? []).map(item => [String(keyOf(item) ?? ''), item]).filter(([key]) => key));
    const newItems = new Map((after?.[collection] ?? []).map(item => [String(keyOf(item) ?? ''), item]).filter(([key]) => key));
    const changed = new Set(entityIds(upserts[collection]));
    const removed = new Set(entityIds(deletes[collection]));
    newItems.forEach((item, key) => {
      if (!oldItems.has(key) || transactionChanged(oldItems.get(key), item)) {
        removed.delete(key);
        changed.add(key);
      }
    });
    oldItems.forEach((_item, key) => {
      if (!newItems.has(key)) {
        changed.delete(key);
        removed.add(key);
      }
    });
    upserts[collection] = [...changed];
    deletes[collection] = [...removed];
  });
  return { upserts, deletes };
}

function reconcileFeatureSettings(local, remote, pending) {
  const hasKeyedChanges = Object.values(pending?.featureUpserts ?? {}).some(items => entityIds(items).length) ||
    Object.values(pending?.featureDeletes ?? {}).some(items => entityIds(items).length);
  if (pending?.features && !hasKeyedChanges) return { ...(local ?? {}) };
  const result = {};
  Object.entries(FEATURE_KEYS).forEach(([collection, keyOf]) => {
    const localItems = Array.isArray(local?.[collection]) ? local[collection] : [];
    const remoteItems = Array.isArray(remote?.[collection]) ? remote[collection] : [];
    const upserts = new Set(entityIds(pending?.featureUpserts?.[collection]));
    const deletes = new Set(entityIds(pending?.featureDeletes?.[collection]));
    const localByKey = new Map(localItems.map(item => [String(keyOf(item) ?? ''), item]).filter(([key]) => key));
    const merged = remoteItems.filter(item => !deletes.has(String(keyOf(item) ?? ''))).map(item =>
      upserts.has(String(keyOf(item) ?? '')) && localByKey.has(String(keyOf(item) ?? ''))
        ? { ...localByKey.get(String(keyOf(item))) }
        : { ...item },
    );
    const seen = new Set(merged.map(item => String(keyOf(item) ?? '')));
    upserts.forEach(key => { if (!seen.has(key) && localByKey.has(key) && !deletes.has(key)) merged.push({ ...localByKey.get(key) }); });
    result[collection] = merged;
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
  const featureChangesPending = Object.values(value?.featureUpserts ?? {}).some(items => entityIds(items).length) ||
    Object.values(value?.featureDeletes ?? {}).some(items => entityIds(items).length);
  return coreChanges || featureChangesPending || Boolean(value?.features);
}

function acknowledgeEntities(current, sent, sentItems, currentItems, keyOf, upsertField, deleteField) {
  const sentById = new Map((sentItems ?? []).map(item => [keyOf(item), item]));
  const currentById = new Map((currentItems ?? []).map(item => [keyOf(item), item]));
  const sentUpserts = new Set(entityIds(sent?.[upsertField]));
  const sentDeletes = new Set(entityIds(sent?.[deleteField]));
  return {
    [upsertField]: entityIds(current?.[upsertField]).filter(id =>
      !sentUpserts.has(id) || !sentById.has(id) || !currentById.has(id) ||
      transactionChanged(sentById.get(id), currentById.get(id))),
    [deleteField]: entityIds(current?.[deleteField]).filter(id =>
      !sentDeletes.has(id) || currentById.has(id)),
  };
}

// A successful request acknowledges its snapshot, never edits made while it was in flight.
export function acknowledgePendingSheetChanges(current, sent, sentState, currentState) {
  const idOf = item => String(item?.id ?? '').trim();
  return {
    ...acknowledgeEntities(current, sent, sentState?.transactions, currentState?.transactions,
      idOf, 'upserts', 'deletes'),
    ...acknowledgeEntities(current, sent, sentState?.accounts, currentState?.accounts,
      idOf, 'accountUpserts', 'accountDeletes'),
    ...acknowledgeEntities(current, sent, sentState?.budgets, currentState?.budgets,
      item => String(item?.category ?? '').trim(), 'budgetUpserts', 'budgetDeletes'),
    featureUpserts: Object.fromEntries(Object.keys(FEATURE_KEYS).map(collection => [collection,
      entityIds(current?.featureUpserts?.[collection]).filter(id =>
        !entityIds(sent?.featureUpserts?.[collection]).includes(id) || transactionChanged(
          (sentState?.featureSettings?.[collection] ?? []).find(item => String(FEATURE_KEYS[collection](item)) === id),
          (currentState?.featureSettings?.[collection] ?? []).find(item => String(FEATURE_KEYS[collection](item)) === id),
        )),
    ])),
    featureDeletes: Object.fromEntries(Object.keys(FEATURE_KEYS).map(collection => [collection,
      entityIds(current?.featureDeletes?.[collection]).filter(id => !entityIds(sent?.featureDeletes?.[collection]).includes(id)),
    ])),
    features: Boolean(current?.features) && (!sent?.features || transactionChanged(
      sentState?.featureSettings ?? {}, currentState?.featureSettings ?? {},
    )),
  };
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
  const featureDelta = featureChanges(beforeState?.featureSettings, afterState?.featureSettings, {
    upserts: current?.featureUpserts,
    deletes: current?.featureDeletes,
  });
  return {
    upserts: [...upserts],
    deletes: [...deletes],
    accountUpserts: accounts.upserts,
    accountDeletes: accounts.deletes,
    budgetUpserts: budgets.upserts,
    budgetDeletes: budgets.deletes,
    featureUpserts: featureDelta.upserts,
    featureDeletes: featureDelta.deletes,
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
    featureSettings: reconcileFeatureSettings(local?.featureSettings, remote?.featureSettings, pendingChanges),
  };
}
