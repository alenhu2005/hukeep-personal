import { normalizeLedgerState } from './storage/ledger-repository.js';

const APP_ID = 'hukeep-personal';

function protectFormula(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = protectFormula(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function transactionsToCsv(transactions) {
  const header = ['類型', '名稱', '金額', '手續費', '分類', '帳戶', '目的帳戶', '日期', '備註', '小分類', '來源', '發票號碼'];
  const rows = transactions.map(transaction =>
    [
      transaction.type,
      transaction.name ?? '',
      transaction.amount,
      transaction.fee ?? 0,
      transaction.category ?? '',
      transaction.account,
      transaction.toAccount ?? '',
      transaction.date,
      transaction.note ?? '',
      transaction.subcategory ?? '',
      transaction.source ?? 'manual',
      transaction.invoiceNumber ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[header.join(','), ...rows].join('\r\n')}`;
}

export function serializeBackup(state, options = {}) {
  const normalized = normalizeLedgerState(state);
  return JSON.stringify(
    {
      app: APP_ID,
      ...normalized,
      exportedAt: options.now ?? new Date().toISOString(),
    },
    null,
    2,
  );
}

export function parseBackup(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.app !== APP_ID || parsed?.schemaVersion !== 1) {
      throw new Error('備份來源或版本不正確');
    }
    if (!Array.isArray(parsed.transactions) || !Array.isArray(parsed.accounts)) {
      throw new Error('備份內容不完整');
    }
    return normalizeLedgerState(parsed);
  } catch (error) {
    if (error instanceof Error && error.message.includes('備份')) throw error;
    throw new Error('備份檔案無法讀取', { cause: error });
  }
}

function compareByKey(current, incoming, key) {
  const currentByKey = new Map(current.map(item => [item[key], item]));
  const incomingByKey = new Map(incoming.map(item => [item[key], item]));
  let added = 0;
  let changed = 0;
  let removed = 0;

  for (const [id, item] of incomingByKey) {
    const previous = currentByKey.get(id);
    if (!previous) added += 1;
    else if (JSON.stringify(previous) !== JSON.stringify(item)) changed += 1;
  }
  for (const id of currentByKey.keys()) {
    if (!incomingByKey.has(id)) removed += 1;
  }
  return { added, changed, removed };
}

export function previewBackupRestore(currentState, importedState) {
  const current = normalizeLedgerState(currentState);
  const imported = normalizeLedgerState(importedState);
  const currentFeatures = current.featureSettings;
  const importedFeatures = imported.featureSettings;
  const counts = {
    transactions: compareByKey(current.transactions, imported.transactions, 'id'),
    accounts: compareByKey(current.accounts, imported.accounts, 'id'),
    budgets: compareByKey(current.budgets, imported.budgets, 'category'),
    recurringRules: compareByKey(currentFeatures.recurringRules, importedFeatures.recurringRules, 'id'),
    monthlySnapshots: compareByKey(currentFeatures.monthlySnapshots, importedFeatures.monthlySnapshots, 'month'),
    reconciliations: compareByKey(currentFeatures.reconciliations, importedFeatures.reconciliations, 'id'),
    preferences: {
      added: 0,
      changed: JSON.stringify(current.preferences) === JSON.stringify(imported.preferences) ? 0 : 1,
      removed: 0,
    },
  };
  return {
    ...counts,
    hasChanges: Object.values(counts).some(({ added, changed, removed }) => added + changed + removed > 0),
  };
}
