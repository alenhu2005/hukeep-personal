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
