import QRCode from 'qrcode';

import { parseBackup, previewBackupRestore, serializeBackup, transactionsToCsv } from './backup.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './config.js';
import { updateOpeningBalances } from './domain/accounts.js';
import { removeBudget, upsertBudget } from './domain/budgets.js';
import { calculateAccountBalances, expenseAmount, expenseCategory, incomeAmount } from './domain/insights.js';
import { bulkUpdateTransactions, linkRefund } from './domain/transaction-tools.js';
import { applyCategoryRules, normalizeEntryTemplate, normalizeCategoryRule, readEntryDraft, saveEntryDraft, clearEntryDraft } from './domain/entry-tools.js';
import { renderSyncInspector } from './views/sync-inspector.js';
import { transferAmounts } from './domain/transfer-fees.js';
import { buildAnalysisWorkspace } from './domain/analysis-workspace.js';
import {
  classifyIncomeLocally,
  classifyLocally,
  getSubcategories,
} from './domain/category-taxonomy.js';
import { parseSpokenTransactions } from './domain/spoken-entry.js';
import { detectSpokenReview } from './domain/spoken-review.js';
import { reconciliationAdjustmentId, reconciliationAdjustmentNote, reconciliationAdjustmentStatus, transactionsAtReconciliation } from './domain/reconciliation.js';
import { isInvestmentTransfer } from './domain/investment-accounting.js';
import {
  acknowledgePendingSheetChanges,
  hasPendingSheetChanges,
  mergeConcurrentLedgerState,
  reconcileLedgerFromSheet,
  updatePendingSheetChanges,
} from './domain/ledger-sync.js';
import {
  applyRecurringRules,
  createMonthlySnapshot,
  findTransactionSignals,
  normalizeFeatureSettings,
  setRecurringRuleEnabled,
  upsertRecurringRule,
} from './domain/ledger-enhancements.js';
import {
  ValidationError,
  createTransaction,
  filterTransactions,
  normalizeStoredTransaction,
  removeTransaction,
  updateTransaction,
} from './domain/transactions.js';
import { escapeHtml, formatMoney, monthLabel, todayInTaipei } from './format.js';
import { hydrateIcons, icon } from './icons.js';
import { createLedgerRepository, normalizeLedgerState, STORAGE_KEY } from './storage/ledger-repository.js';
import {
  claimDevicePairingCode,
  classifyExpenseWithAi,
  createDevicePairingCode,
  deleteLedgerBudgetFromSheet,
  enqueueSpokenEntry,
  loadLedgerStateFromSheet,
  syncLedgerChangesToSheet,
} from './services/import-proxy.js';
import {
  createDeviceBindingPayload,
  createDeviceBindingStore,
  parseDeviceBindingHash,
} from './services/device-binding.js';
import { renderView, renderAccountHistory } from './views.js';

const LAST_SHEET_SYNC_KEY = 'hukeep_last_sheet_sync_at';
const PENDING_SHEET_CHANGES_KEY = 'hukeep_pending_sheet_changes_v1';
const BUDGET_SYNC_MIGRATION_KEY = 'hukeep_budget_sync_migrated_v2';
const INVESTMENT_SYNC_REPAIR_KEY = 'hukeep_investment_sync_repaired_v2';
const AUTO_SYNC_DEBOUNCE_MS = 800;
const SHEET_RETRY_BASE_DELAY_MS = 4_000;
const SHEET_RETRY_MAX_DELAY_MS = 60_000;
const BACKGROUND_PULL_INTERVAL_MS = 2 * 60 * 1000;
const RESUME_PULL_THRESHOLD_MS = 15 * 1000;

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shiftDate(dateText, offset) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return todayInTaipei();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function latestPresetMonth(transactions, preset) {
  const values = Array.isArray(transactions) ? transactions : [];
  const matching = preset === 'review'
    ? values.filter(transaction => transaction?.aiStatus === 'pending')
    : preset === 'attention'
      ? (() => {
          const signals = findTransactionSignals(values);
          return values.filter(transaction => signals.duplicates.has(transaction?.id) || signals.anomalies.has(transaction?.id));
        })()
      : [];
  const latestDate = matching
    .map(transaction => transaction?.date)
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .toSorted((left, right) => right.localeCompare(left))[0];
  return latestDate ? latestDate.slice(0, 7) : '';
}

function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function safeViewFromHash() {
  const value = location.hash.replace('#', '');
  return ['overview', 'history', 'budgets', 'insights'].includes(value) ? value : 'overview';
}

export function renderAccountOptions(accounts, selected, excluded = '') {
  return accounts
    .map(account => {
      const id = escapeHtml(account.id);
      const name = escapeHtml(account.name);
      const selectedAttr = account.id === selected ? 'selected' : '';
      const disabledAttr = account.id === excluded ? 'disabled' : '';
      return `<option value="${id}" ${selectedAttr} ${disabledAttr}>${name}</option>`;
    })
    .join('');
}

export function renderAccountButtons(accounts, selected, excluded = '', target = '') {
  const safeTarget = escapeHtml(target);
  return accounts
    .map(account => {
      const id = escapeHtml(account.id);
      const name = escapeHtml(account.name);
      const accountIcon = escapeHtml(account.icon);
      const active = account.id === selected;
      const disabled = account.id === excluded;
      return `<button type="button" data-account-for="${safeTarget}" data-account-value="${id}" aria-pressed="${active}" ${disabled ? 'disabled' : ''}><span class="account-choice-icon" aria-hidden="true">${accountIcon}</span><span>${name}</span></button>`;
    })
    .join('');
}

export function createApp() {
  const repository = createLedgerRepository(localStorage);
  const deviceBinding = createDeviceBindingStore(localStorage, sessionStorage);
  const incomingDeviceBinding = parseDeviceBindingHash(location.hash);
  if (incomingDeviceBinding) {
    deviceBinding.remember(incomingDeviceBinding);
    history.replaceState(null, '', `${location.pathname}${location.search}#overview`);
  }
  let state = repository.load();
  let view = safeViewFromHash();
  let selectedMonth = todayInTaipei().slice(0, 7);
  let historyFilters = { query: '', type: '', category: '', subcategory: '', account: '', preset: 'all', monthScope: 'month' };
  let historySelection = { enabled: false, ids: [] };
  const deletedDuringSession = new Set();
  let insightFilters = {
    period: 'month', section: 'overview', category: '', subcategory: '', selectedDate: '',
    anchorDate: todayInTaipei(), compareSubcategories: [],
  };
  let toastTimer = null;
  let classificationReady = false;
  let manualCategoryChosen = false;
  let draftStorageWarning = false;
  let classificationTimer = null;
  let classificationRequest = 0;
  let sheetPullInFlight = false;
  let sheetWriteInFlight = false;
  let voiceUploadInFlight = false;
  let voiceUploadCount = 0;
  let lastSheetPullAt = 0;
  let pendingSheetSyncTimer = null;
  let pendingSheetRetryCount = 0;
  let backgroundPullRetryTimer = null;
  let backgroundPullRetryCount = 0;
  let deviceBindingLink = '';
  let pendingBackup = null;
  let spokenReviewDrafts = null;
  let nextSheetRetryAt = 0;
  let sheetConfigurationNotice = '';

  const main = document.querySelector('#app-main');
  const transactionDialog = document.querySelector('#transaction-dialog');
  const toolsDialog = document.querySelector('#tools-dialog');
  const transactionForm = document.querySelector('#transaction-form');
  const toast = document.querySelector('#toast');

  function rememberProxySession(endpoint, proxyToken) {
    return deviceBinding.remember({ endpoint, proxyToken });
  }

  function proxySession() {
    const stored = deviceBinding.read();
    const endpoint =
      stored.endpoint ||
      state.preferences.proxyEndpoint ||
      import.meta.env.VITE_INVOICE_PROXY_URL ||
      '';
    if (endpoint && stored.proxyToken && !stored.bound) {
      return rememberProxySession(endpoint, stored.proxyToken);
    }
    return { endpoint: endpoint.trim(), proxyToken: stored.proxyToken, bound: Boolean(endpoint && stored.proxyToken) };
  }


  function updateDeviceBindingStatus() {
    const status = document.querySelector('#device-binding-status');
    if (!status) return;
    const binding = proxySession();
    status.classList.toggle('bound', binding.bound);
    status.textContent = binding.bound
      ? '這台裝置已安全綁定 Sheet，現在可直接同步。'
      : '這台裝置尚未完成安全綁定。';
    document.querySelector('#device-binding-share').hidden = !binding.bound;
    document.querySelector('#device-pairing-claim').hidden = binding.bound;
  }

  async function openDeviceBindingDialog() {
    const credentials = proxySession();
    if (!credentials.bound) {
      showToast('這台裝置尚未綁定 Sheet，無法產生手機 QR。', 'error');
      return;
    }
    const codeElement = document.querySelector('#device-binding-code');
    codeElement.textContent = '正在產生…';
    try {
      const pairing = await createDevicePairingCode(credentials);
      const payload = createDeviceBindingPayload(credentials);
      const appUrl = new URL(import.meta.env.BASE_URL, location.origin);
      deviceBindingLink = `${appUrl.href}#bind=${payload}`;
      document.querySelector('#device-binding-qr').src = await QRCode.toDataURL(deviceBindingLink, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 640,
      });
      codeElement.textContent = pairing.code;
      document.querySelector('#device-binding-code-expiry').textContent = '一次使用，10 分鐘後失效';
      document.querySelector('#device-binding-dialog').showModal();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function claimDeviceBinding() {
    const input = document.querySelector('#device-pairing-code');
    const button = document.querySelector('#device-pairing-claim-button');
    const endpoint = proxySession().endpoint;
    if (!endpoint) {
      showToast('這個版本尚未設定 Sheet 連線網址。', 'error');
      return;
    }
    button.disabled = true;
    try {
      const result = await claimDevicePairingCode({ endpoint, code: input.value });
      rememberProxySession(endpoint, result.proxyToken);
      input.value = '';
      updateDeviceBindingStatus();
      setSyncStatus('local', { detail: '手機已綁定，可從 Sheet 讀取最新資料' });
      showToast('手機已完成 Sheet 綁定。');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function copyDeviceBindingLink() {
    if (!deviceBindingLink) return;
    try {
      await navigator.clipboard.writeText(deviceBindingLink);
      showToast('手機綁定連結已複製。');
    } catch {
      showToast('無法複製，請直接用手機掃描 QR。', 'error');
    }
  }

  function storedLastSyncAt() {
    try {
      const value = Number(localStorage.getItem(LAST_SHEET_SYNC_KEY));
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function readPendingSheetChanges() {
    try {
      const value = JSON.parse(localStorage.getItem(PENDING_SHEET_CHANGES_KEY) || '{}');
      return {
        upserts: Array.isArray(value?.upserts) ? value.upserts : [],
        deletes: Array.isArray(value?.deletes) ? value.deletes : [],
        ...(Array.isArray(value?.refundClears) && value.refundClears.length ? { refundClears: value.refundClears } : {}),
        accountUpserts: Array.isArray(value?.accountUpserts) ? value.accountUpserts : [],
        accountDeletes: Array.isArray(value?.accountDeletes) ? value.accountDeletes : [],
        budgetUpserts: Array.isArray(value?.budgetUpserts) ? value.budgetUpserts : [],
        budgetDeletes: Array.isArray(value?.budgetDeletes) ? value.budgetDeletes : [],
        featureUpserts: value?.featureUpserts && typeof value.featureUpserts === 'object' ? value.featureUpserts : {},
        featureDeletes: value?.featureDeletes && typeof value.featureDeletes === 'object' ? value.featureDeletes : {},
        features: Boolean(value?.features),
      };
    } catch {
      return {
        upserts: [],
        deletes: [],
        accountUpserts: [],
        accountDeletes: [],
        budgetUpserts: [],
        budgetDeletes: [],
        featureUpserts: {},
        featureDeletes: {},
        features: false,
      };
    }
  }

  function writePendingSheetChanges(value) {
    try {
      localStorage.setItem(PENDING_SHEET_CHANGES_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function migrateLegacyBudgetChanges() {
    try {
      if (localStorage.getItem(BUDGET_SYNC_MIGRATION_KEY)) return;
      const pending = readPendingSheetChanges();
      if (!pending.budgetUpserts.length && !pending.budgetDeletes.length && state.budgets.length) {
        writePendingSheetChanges({
          ...pending,
          budgetUpserts: state.budgets.map(budget => budget.category),
        });
      }
      localStorage.setItem(BUDGET_SYNC_MIGRATION_KEY, '1');
    } catch {
      // The normal change journal remains available even if this one-time migration cannot persist.
    }
  }

  function discardLegacyInvestmentAccountUpload() {
    try {
      if (localStorage.getItem(INVESTMENT_SYNC_REPAIR_KEY)) return;
      const pending = readPendingSheetChanges();
      writePendingSheetChanges({
        ...pending,
        accountUpserts: pending.accountUpserts.filter(id => id !== 'investment'),
      });
      localStorage.setItem(INVESTMENT_SYNC_REPAIR_KEY, '1');
    } catch {
      // A subsequent Sheet pull still repairs the account from the canonical snapshot.
    }
  }

  function queueInvestmentSheetDifferences(remote) {
    const remoteTransactions = new Map(
      (remote?.transactions || []).map(transaction => [transaction.id, transaction]),
    );
    const transactionIds = state.transactions
      .filter(isInvestmentTransfer)
      .filter(transaction => {
        const remoteTransaction = remoteTransactions.get(transaction.id);
        return !remoteTransaction ||
          remoteTransaction.type !== 'transfer' ||
          remoteTransaction.category !== '投資' ||
          remoteTransaction.account !== transaction.account ||
          remoteTransaction.toAccount !== transaction.toAccount;
      })
      .map(transaction => transaction.id);
    const remoteInvestment = (remote?.accounts || []).find(account => account.id === 'investment');
    const localInvestment = state.accounts.find(account => account.id === 'investment');
    const accountChanged = localInvestment && (
      !remoteInvestment ||
      remoteInvestment.name !== localInvestment.name ||
      Number(remoteInvestment.openingBalance) !== Number(localInvestment.openingBalance)
    );
    if (!transactionIds.length && !accountChanged) return;
    const pending = readPendingSheetChanges();
    writePendingSheetChanges({
      ...pending,
      upserts: [...new Set([...pending.upserts, ...transactionIds])],
      accountUpserts: accountChanged
        ? [...new Set([...pending.accountUpserts, 'investment'])]
        : pending.accountUpserts,
    });
    schedulePendingSheetSync();
  }

  function setSyncStatus(status, options = {}) {
    const indicator = document.querySelector('#sync-indicator');
    if (status === 'syncing') return;
    if (status === 'synced' && hasPendingSheetChanges(readPendingSheetChanges())) status = 'local';
    const labels = {
      local: '僅本機',
      syncing: '同步中',
      pending: 'AI 待審',
      synced: '已同步',
      error: '待重試',
    };
    const lastAt = options.lastAt || storedLastSyncAt();
    const timeLabel = lastAt
      ? new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(lastAt)
      : '';
    const label = labels[status] || labels.local;
    indicator.dataset.status = status;
    indicator.querySelector('strong').textContent = status === 'synced' && timeLabel
      ? `${label} ${timeLabel}`
      : label;
    indicator.setAttribute(
      'aria-label',
      options.detail || `${label}${timeLabel ? `，最後更新 ${timeLabel}` : ''}`,
    );
    indicator.title = indicator.getAttribute('aria-label');
  }

  function rememberSuccessfulSync() {
    const now = Date.now();
    lastSheetPullAt = now;
    pendingSheetRetryCount = 0;
    nextSheetRetryAt = 0;
    sheetConfigurationNotice = '';
    backgroundPullRetryCount = 0;
    clearTimeout(backgroundPullRetryTimer);
    backgroundPullRetryTimer = null;
    try {
      localStorage.setItem(LAST_SHEET_SYNC_KEY, String(now));
    } catch {
      // The visual state still updates when timestamp persistence is unavailable.
    }
    setSyncStatus('synced', { lastAt: now });
    updateSyncHealthStatus();
  }

  function persist(nextState, options = {}) {
    const previousPending = readPendingSheetChanges();
    let journalWritten = false;
    try {
      const latestState = repository.load();
      const merged = mergeConcurrentLedgerState(state, nextState, latestState);
      const normalized = normalizeLedgerState(options.protectPending
        ? reconcileLedgerFromSheet(latestState, merged, previousPending)
        : merged);
      if (!options.sheetSourced) {
        const nextPending = updatePendingSheetChanges(previousPending, latestState, normalized);
        if (!writePendingSheetChanges(nextPending)) throw new Error('無法儲存同步佇列');
        journalWritten = true;
        if (JSON.stringify(previousPending) !== JSON.stringify(nextPending) && hasPendingSheetChanges(nextPending)) {
          pendingSheetRetryCount = 0;
          schedulePendingSheetSync();
        }
      }
      state = repository.save(normalized);
      if (!options.sheetSourced && hasPendingSheetChanges(readPendingSheetChanges())) {
        setSyncStatus('local', { detail: '資料已儲存在本機，稍後自動上傳' });
      }
      updateSyncHealthStatus();
      return true;
    } catch (error) {
      if (journalWritten) writePendingSheetChanges(previousPending);
      showToast('無法儲存，請先匯出備份並檢查瀏覽器空間。', 'error');
      console.error(error);
      return false;
    }
  }

  function applyDueRecurringTransactions() {
    const featureSettings = normalizeFeatureSettings(state.featureSettings);
    const { created } = applyRecurringRules(
      featureSettings.recurringRules,
      state.transactions,
      todayInTaipei(),
    );
    if (!created.length) return false;
    return persist({ ...state, featureSettings, transactions: [...state.transactions, ...created] });
  }

  function captureCompletedMonthSnapshot() {
    const [year, month] = todayInTaipei().slice(0, 7).split('-').map(Number);
    const completedMonth = shiftMonth(`${year}-${String(month).padStart(2, '0')}`, -1);
    const featureSettings = normalizeFeatureSettings(state.featureSettings);
    if (featureSettings.monthlySnapshots.some(snapshot => snapshot.month === completedMonth)) return false;
    const snapshot = createMonthlySnapshot(state, completedMonth);
    return persist({
      ...state,
      featureSettings: {
        ...featureSettings,
        monthlySnapshots: [...featureSettings.monthlySnapshots, snapshot],
      },
    });
  }

  function showToast(message, tone = 'default', action = null) {
    clearTimeout(toastTimer);
    toast.className = `toast ${tone}`;
    const safeMessage = escapeHtml(message);
    const safeLabel = action ? escapeHtml(action.label) : '';
    toast.innerHTML = `<span>${safeMessage}</span>${action ? `<button type="button" id="toast-action">${safeLabel}</button>` : ''}`;
    toast.hidden = false;
    if (action) toast.querySelector('button')?.addEventListener('click', action.handler, { once: true });
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 5500);
  }

  function applyTheme() {
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = state.preferences.theme === 'dark' || (state.preferences.theme === 'system' && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('#theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon', 19);
    document.querySelector('meta[name="theme-color"]').content = dark ? '#131512' : '#f4f1e8';
  }

  function render(options = {}) {
    historySelection.ids = historySelection.ids.filter(id => state.transactions.some(item => item.id === id));
    const disclosures = new Map([...main.querySelectorAll('[data-analysis-disclosure]')]
      .map(element => [element.dataset.analysisDisclosure, element.open]));
    main.innerHTML = renderView(view, state, selectedMonth, historyFilters, { insightFilters, historySelection });
    main.querySelectorAll('[data-analysis-disclosure]').forEach(element => {
      if (disclosures.has(element.dataset.analysisDisclosure)) element.open = disclosures.get(element.dataset.analysisDisclosure);
    });
    if (toolsDialog.open) {
      renderRecurringRules();
      renderReconciliations();
      renderCategoryRules();
    }
    document.querySelector('#month-title').textContent = monthLabel(selectedMonth);
    document.querySelectorAll('[data-nav-view]').forEach(button => {
      const active = button.dataset.navView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    if (options.focusMain) main.focus({ preventScroll: true });
  }

  function navigate(nextView) {
    view = nextView;
    history.replaceState(null, '', `#${view}`);
    render({ focusMain: true });
    scrollTo({ top: 0, behavior: 'smooth' });
    syncOnViewChange();
  }

  function accountOptions(selected, excluded = '') {
    return renderAccountOptions(state.accounts, selected, excluded);
  }

  function syncAccountButtons(select, excluded = '') {
    const group = transactionForm.querySelector(`[data-account-for="${select.id}"]`);
    if (!group) return;
    group.innerHTML = renderAccountButtons(state.accounts, select.value, excluded, select.id);
  }

  function setAccountOptions(select, selected, excluded = '') {
    select.innerHTML = accountOptions(selected, excluded);
    const validSelection = state.accounts.some(
      account => account.id === selected && account.id !== excluded,
    );
    if (!validSelection) {
      select.value = state.accounts.find(account => account.id !== excluded)?.id || '';
    }
    syncAccountButtons(select, excluded);
  }

  function setSubcategoryOptions(type, selectedSubcategory = '') {
    const category = transactionForm.elements.category.value;
    const refundEditing = state.transactions.find(item => item.id === transactionForm.elements.id.value)?.refundOf;
    const subcategories = getSubcategories(category, refundEditing ? 'expense' : type);
    transactionForm.elements.subcategory.innerHTML = subcategories
      .map(
        subcategory =>
          `<option value="${escapeHtml(subcategory)}" ${subcategory === selectedSubcategory ? 'selected' : ''}>${escapeHtml(subcategory)}</option>`,
      )
      .join('');
  }

  function setClassificationVisibility(type, ready) {
    const transfer = type === 'transfer';
    const editing = Boolean(transactionForm.elements.id.value);
    classificationReady = transfer || ready;
    document.querySelector('#category-field').hidden = transfer || !(editing || ready);
    document.querySelector('#subcategory-field').hidden = transfer || !(editing || ready);
  }

  function setTransactionType(
    type,
    selectedCategory = '',
    selectedSubcategory = '',
    options = {},
  ) {
    transactionForm.elements.type.value = type;
    transactionForm.querySelectorAll('[data-transaction-type]').forEach(button => {
      const active = button.dataset.transactionType === type;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('active', active);
    });
    const transfer = type === 'transfer';
    document.querySelector('#to-account-field').hidden = !transfer;
    document.querySelector('#transfer-fee-field').hidden = !transfer;
    transactionForm.elements.category.required = !transfer;
    transactionForm.elements.subcategory.required = !transfer;
    transactionForm.elements.toAccount.required = transfer;
    const refundEditing = state.transactions.find(item => item.id === transactionForm.elements.id.value)?.refundOf;
    const categories = type === 'income' && !refundEditing ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    transactionForm.elements.category.innerHTML = categories
      .map(
        category =>
          `<option value="${escapeHtml(category)}" ${category === selectedCategory ? 'selected' : ''}>${escapeHtml(category)}</option>`,
      )
      .join('');
    if (!transfer) setSubcategoryOptions(type, selectedSubcategory);
    setClassificationVisibility(type, Boolean(options.classificationReady));
    updateDestinationAccounts();
    updateTransferPreview(transactionForm, document.querySelector('#transfer-preview'));
  }

  function updateTransferPreview(form, output) {
    const amount = Number(form.elements.amount.value);
    const fee = Number(form.elements.fee.value || 0);
    const transfer = form.elements.type.value === 'transfer';
    const invalidIncludedFee = transfer && amount > 0 && form.elements.feeMode.value === 'included' && fee >= amount;
    form.elements.fee.setCustomValidity(invalidIncludedFee ? '內扣手續費必須小於轉帳金額' : '');
    if (!transfer) return;
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(fee) || fee < 0 || invalidIncludedFee) {
      output.textContent = invalidIncludedFee ? '內扣手續費必須小於轉帳金額' : '';
      return;
    }
    const amounts = transferAmounts({ amount, fee, feeMode: form.elements.feeMode.value });
    output.innerHTML = [['總扣款', amounts.debit], ['實收', amounts.credit], ['手續費', amounts.fee]]
      .map(([label, value]) => `<span><small>${label}</small><strong>${escapeHtml(formatMoney(value))}</strong></span>`).join('');
  }

  function updateDestinationAccounts(selected = '') {
    const account = transactionForm.elements.account.value;
    setAccountOptions(transactionForm.elements.toAccount, selected, account);
    syncAccountButtons(transactionForm.elements.account);
  }

  function openTransactionDialog(transaction = null) {
    clearTimeout(classificationTimer);
    classificationRequest += 1;
    manualCategoryChosen = Boolean(transaction);
    transactionForm.reset();
    document.querySelector('#manual-entry').open = Boolean(transaction);
    document.querySelector('#transaction-error').hidden = true;
    transactionForm.elements.id.value = transaction?.id || '';
    transactionForm.elements.name.value = transaction?.name || transaction?.note || '';
    transactionForm.elements.amount.value = transaction?.amount || '';
    transactionForm.elements.fee.value = transaction?.fee || '';
    transactionForm.elements.feeMode.value = transaction?.type === 'transfer' ? transaction.feeMode || 'additional' : 'included';
    transactionForm.elements.date.value = transaction?.date || todayInTaipei();
    transactionForm.elements.note.value = transaction?.note || '';
    setAccountOptions(transactionForm.elements.account, transaction?.account || 'cash');
    setTransactionType(
      transaction?.type || 'expense',
      transaction?.category || '',
      transaction?.subcategory || '',
      { classificationReady: Boolean(transaction) },
    );
    if (transaction?.toAccount) updateDestinationAccounts(transaction.toAccount);
    document.querySelector('#transaction-dialog-title').textContent = transaction ? '編輯這筆' : '記一筆';
    document.querySelector('#voice-transcript').value = '';
    spokenReviewDrafts = null;
    document.querySelector('#voice-review').hidden = true;
    const voiceStatus = document.querySelector('#voice-status');
    voiceStatus.textContent = '';
    voiceStatus.hidden = true;
    renderEntryTemplates();
    document.querySelector('#discard-entry-draft').hidden = true;
    if (!transaction) {
      const draft = readEntryDraft(localStorage);
      if (draft) {
        fillEntryForm(draft);
        document.querySelector('#voice-transcript').value = draft.transcript || '';
        document.querySelector('#manual-entry').open = Boolean(draft.manualOpen);
        document.querySelector('#discard-entry-draft').hidden = ![draft.name, draft.amount, draft.note, draft.transcript].some(value => String(value || '').trim());
      }
    }
    if (!transactionDialog.open) transactionDialog.showModal();
    requestAnimationFrame(() =>
      (transaction ? transactionForm.elements.name : document.querySelector('#voice-transcript')).focus(),
    );
  }

  function fillEntryForm(values) {
    manualCategoryChosen = Boolean(values.category);
    setAccountOptions(transactionForm.elements.account, values.account || 'cash');
    setTransactionType(values.type || 'expense', values.category || '', values.subcategory || '', { classificationReady: Boolean(values.category) || values.type === 'transfer' });
    for (const key of ['name', 'amount', 'date', 'note', 'fee', 'feeMode']) {
      if (values[key] != null) transactionForm.elements[key].value = values[key];
    }
    if (values.toAccount) updateDestinationAccounts(values.toAccount);
    updateTransferPreview(transactionForm, document.querySelector('#transfer-preview'));
  }

  function renderEntryTemplates() {
    const templates = normalizeFeatureSettings(state.featureSettings).templates || [];
    document.querySelector('#entry-templates').innerHTML = templates.map(item =>
      `<span><button type="button" data-entry-template="${escapeHtml(item.id)}">${escapeHtml(item.label || item.name)} · ${escapeHtml(formatMoney(item.amount))}</button><button type="button" data-remove-entry-template="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.label || item.name)} 範本">×</button></span>`,
    ).join('');
  }

  function rememberEntryDraft() {
    if (!transactionDialog.open || transactionForm.elements.id.value) return;
    const values = Object.fromEntries(new FormData(transactionForm));
    const draft = { ...values, ...(!classificationReady ? { category: '', subcategory: '' } : {}), transcript: document.querySelector('#voice-transcript').value, manualOpen: document.querySelector('#manual-entry').open };
    const hasContent = [draft.name, draft.amount, draft.note, draft.transcript].some(value => String(value || '').trim());
    document.querySelector('#discard-entry-draft').hidden = !hasContent;
    if (!hasContent) { clearEntryDraft(localStorage); return; }
    if (!saveEntryDraft(draft, localStorage) && !draftStorageWarning) {
      draftStorageWarning = true;
      showToast('草稿暫時無法儲存，請勿關閉此表單，並檢查瀏覽器空間。', 'error');
    }
  }

  function rememberCategoryRule(input, features) {
    if (!document.querySelector('#remember-category-rule').checked || input.type === 'transfer') return features;
    const match = input.merchant || input.name;
    const rule = normalizeCategoryRule({ id: crypto.randomUUID(), match, type: input.type, category: input.category, subcategory: input.subcategory, createdAt: new Date().toISOString() });
    if (!rule) throw new ValidationError('請選擇完整分類後再儲存分類規則');
    const categoryRules = [...(features.categoryRules || []).filter(item => item.type !== rule.type || item.match.toLocaleLowerCase() !== rule.match.toLocaleLowerCase()), rule];
    if (categoryRules.length > 100) throw new ValidationError('分類規則最多 100 個，請先移除不需要的規則');
    return { ...features, categoryRules };
  }

  function saveEntryTemplate() {
    try {
      if (!classificationReady) applyLocalTransactionClassification();
      const values = Object.fromEntries(new FormData(transactionForm));
      const template = normalizeEntryTemplate({ ...values, id: crypto.randomUUID(), label: values.name, amount: Number(values.amount), fee: Number(values.fee || 0), createdAt: new Date().toISOString() }, { accounts: state.accounts });
      if (!template) throw new Error('請先填妥名稱、金額、帳戶與分類');
      const features = normalizeFeatureSettings(state.featureSettings);
      if ((features.templates || []).length >= 100) throw new Error('範本最多 100 個');
      if (!persist({ ...state, featureSettings: { ...features, templates: [...(features.templates || []), template] } })) return;
      renderEntryTemplates();
      showToast('已存為快速範本。');
    } catch (error) { showToast(error.message, 'error'); }
  }

  function personalClassification(input) {
    return applyCategoryRules(input, normalizeFeatureSettings(state.featureSettings).categoryRules || []);
  }

  async function classifyTransactionNote({ force = false } = {}) {
    const type = transactionForm.elements.type.value;
    if (type === 'transfer') return true;
    const name = transactionForm.elements.name.value.trim();
    const note = transactionForm.elements.note.value.trim();
    const classificationInput = `${name} ${note}`.trim();
    if (!classificationInput && !force) {
      return false;
    }
    const request = ++classificationRequest;

    const local =
      type === 'income'
        ? classifyIncomeLocally(classificationInput)
        : classifyLocally({ merchant: name, items: [note] });
    const classificationText =
      parseSpokenTransactions(classificationInput, { today: todayInTaipei() })[0].classificationText || classificationInput;
    let classification = local;
    const { endpoint, proxyToken } = proxySession();
    if (endpoint && proxyToken) {
      try {
        classification = await classifyExpenseWithAi({
          type, endpoint, proxyToken, merchant: classificationText,
          items: [classificationText], fallback: local,
        });
      } catch {
        // Local classification remains available offline.
      }
    }
    if (request !== classificationRequest) return false;
    const personal = personalClassification({ type, name, category: classification.topCategory, subcategory: classification.subcategory });
    classification = { topCategory: personal.category, subcategory: personal.subcategory };
    setTransactionType(type, classification.topCategory, classification.subcategory, {
      classificationReady: true,
    });
    return true;
  }

  function scheduleTransactionClassification() {
    if (transactionForm.elements.id.value || manualCategoryChosen) return;
    classificationReady = transactionForm.elements.type.value === 'transfer';
    clearTimeout(classificationTimer);
    classificationTimer = setTimeout(() => classifyTransactionNote(), 650);
  }

  function applyLocalTransactionClassification() {
    const type = transactionForm.elements.type.value;
    if (type === 'transfer') {
      classificationReady = true;
      return;
    }
    const text = `${transactionForm.elements.name.value} ${transactionForm.elements.note.value}`.trim();
    const classification =
      type === 'income'
        ? classifyIncomeLocally(text)
        : classifyLocally({ merchant: text, items: [text] });
    const personal = personalClassification({ type, name: transactionForm.elements.name.value.trim(), category: classification.topCategory, subcategory: classification.subcategory });
    setTransactionType(type, personal.category, personal.subcategory, {
      classificationReady: true,
    });
  }

  function localSpokenTransactions(drafts, transcript, groupId) {
    const now = new Date().toISOString();
    return drafts.flatMap((draft, index) => {
      if (!Number.isSafeInteger(Number(draft?.amount)) || Number(draft.amount) <= 0) return [];
      const clientId = draft.clientId || `${groupId}:${index + 1}`;
      try {
        return [createTransaction(personalClassification({
          ...draft,
          source: 'voice',
          sourceId: clientId,
          rawTranscript: transcript,
          aiStatus: 'pending',
          groupId,
          note: draft.note || '',
        }), { id: `voice:${clientId}`, now })];
      } catch {
        return [];
      }
    });
  }

  function acknowledgeUploadedSpokenTransactions(uploadedIds, sentState) {
    if (!uploadedIds.length) return;
    const pending = readPendingSheetChanges();
    writePendingSheetChanges(acknowledgePendingSheetChanges(
      pending,
      { upserts: uploadedIds, deletes: [] },
      { transactions: sentState.transactions.filter(transaction => uploadedIds.includes(transaction.id)) },
      state,
    ));
  }

  function renderSpokenReview(drafts, review) {
    spokenReviewDrafts = drafts;
    const container = document.querySelector('#voice-review');
    const reason = review.reasons.includes('account') ? '請確認各筆付款帳戶' : '請確認品項與金額';
    container.innerHTML = `<p>${reason}，確認後才會記帳。</p>${drafts.map((draft, index) =>
      `<div class="voice-review-item"><strong>第 ${index + 1} 筆</strong><label>品項<input data-review-name="${index}" maxlength="120" value="${escapeHtml(draft.name || '')}" required /></label><label>金額<input data-review-amount="${index}" type="number" min="1" step="1" value="${Number(draft.amount) || ''}" required /></label><label>帳戶<select data-review-account="${index}">${renderAccountOptions(state.accounts, draft.account || 'cash')}</select></label></div>`
    ).join('')}<div class="sheet-sync-actions"><button id="voice-review-confirm" class="primary-button" type="button">確認 ${drafts.length} 筆</button><button id="voice-review-cancel" class="secondary-button" type="button">返回修改</button></div>`;
    container.hidden = false;
    container.scrollIntoView({ block: 'nearest' });
  }

  async function submitSpokenEntry(value, confirmedDrafts = null) {
    const button = document.querySelector('#voice-submit-button');
    if (button.disabled) return;
    const transcript = String(value ?? '').trim();
    if (!transcript) {
      showToast('請先說一句或輸入口語內容。', 'error');
      return;
    }
    const credentials = proxySession();
    const drafts = confirmedDrafts || parseSpokenTransactions(transcript, { today: todayInTaipei() });
    if (!confirmedDrafts) {
      const review = detectSpokenReview(transcript, drafts);
      if (review.needsReview) {
        renderSpokenReview(drafts, review);
        return;
      }
    }
    const groupId = globalThis.crypto?.randomUUID?.() || `voice-group-${Date.now()}`;
    const stableDrafts = drafts.map((draft, index) => ({
      ...personalClassification(draft),
      clientId: `${drafts.length > 1 ? 'multi:' : ''}${groupId}:${index + 1}`,
    }));
    const localTransactions = localSpokenTransactions(stableDrafts, transcript, groupId);
    if (!localTransactions.length) {
      showToast('這段內容沒有辨識到正整數金額，請補上金額後再試。', 'error');
      return;
    }
    // Local-first: the record is successful immediately. The network request
    // runs in the background and the same stable IDs make retries idempotent.
    if (credentials.bound) {
      voiceUploadCount += 1;
      voiceUploadInFlight = true;
    }
    if (!persist({ ...state, transactions: [...state.transactions, ...localTransactions] })) {
      voiceUploadCount = Math.max(0, voiceUploadCount - (credentials.bound ? 1 : 0));
      voiceUploadInFlight = voiceUploadCount > 0;
      return;
    }
    document.querySelector('#voice-transcript').value = '';
    clearEntryDraft(localStorage);
    spokenReviewDrafts = null;
    document.querySelector('#voice-review').hidden = true;
    transactionDialog.close();
    render();
    setSyncStatus('local', {
      detail: credentials.bound
        ? '已先儲存在本機，正在背景同步；若離線會在恢復連線後自動上傳'
        : '已先儲存在本機，綁定 Sheet 後會自動上傳',
    });
    showToast(`已先記下 ${localTransactions.length} 筆，網路恢復後會自動上傳。`);
    if (!credentials.bound) {
      schedulePendingSheetSync();
      return;
    }

    const sentState = state;
    const mergeUploaded = result => {
      const deletedIds = new Set([...readPendingSheetChanges().deletes, ...deletedDuringSession]);
      const uploaded = result.transactions.map(normalizeStoredTransaction).filter(item => item && !deletedIds.has(item.id) && !deletedIds.has(`voice:${item.sourceId}`));
      if (!uploaded.length) return [];
      const byId = new Map(uploaded.map(transaction => [transaction.id, transaction]));
      const bySourceId = new Map(uploaded.filter(transaction => transaction.sourceId)
        .map(transaction => [transaction.sourceId, transaction]));
      const fingerprint = transaction => [
        transaction.groupId,
        transaction.type,
        transaction.amount,
        transaction.date,
        transaction.account,
        transaction.toAccount || '',
      ].join('|');
      const byFingerprint = new Map(uploaded.filter(transaction => transaction.groupId)
        .map(transaction => [fingerprint(transaction), transaction]));
      const consumedUploadedIds = new Set();
      const acknowledgedLocalIds = [];
      const merged = state.transactions.map(item => {
        const replacement = byId.get(item.id) || bySourceId.get(item.sourceId) || byFingerprint.get(fingerprint(item));
        if (replacement) {
          consumedUploadedIds.add(replacement.id);
          acknowledgedLocalIds.push(item.id);
        }
        // Keep edits made while the background request was in flight.
        if (replacement && (!item.userEditedAt || item.updatedAt <= sentState.transactions.find(sent => sent.id === item.id)?.updatedAt)) {
          return replacement;
        }
        return item;
      });
      const known = new Set(merged.map(transaction => transaction.id));
      const transactions = [...merged, ...uploaded.filter(transaction =>
        !consumedUploadedIds.has(transaction.id) && !known.has(transaction.id),
      )];
      if (!persist({ ...state, transactions }, { sheetSourced: true })) return [];
      acknowledgeUploadedSpokenTransactions(acknowledgedLocalIds, sentState);
      return uploaded;
    };
    try {
      const firstResult = await enqueueSpokenEntry({
        ...credentials,
        transcript,
        draft: stableDrafts[0],
        drafts: stableDrafts,
        groupId,
      });
      mergeUploaded(firstResult);
      // Older GAS versions consume only `draft`; keep the compatibility path,
      // but each fallback draft still carries its stable clientId.
      const handledDrafts = Math.max(1, Math.min(firstResult.transactions.length, stableDrafts.length));
      const remainingDrafts = stableDrafts.slice(handledDrafts);
      for (const draft of remainingDrafts) {
        const accountName = state.accounts.find(account => account.id === draft.account)?.name
          || draft.account
          || '現金';
        const direction = draft.type === 'income' ? '收入' : '用';
        const itemTranscript = `${draft.name} ${draft.amount} 元${direction}${accountName}`;
        const result = await enqueueSpokenEntry({
          ...credentials,
          transcript: itemTranscript,
          draft,
          drafts: [draft],
          groupId,
        });
        mergeUploaded(result);
      }
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      render();
      updateSyncHealthStatus();
    } catch (error) {
      // The local record remains authoritative until a later retry succeeds.
      // Do not alarm the user or ask them to resend the same sentence.
      console.warn('背景語音上傳暫緩：', error);
      setSyncStatus('local', { detail: '已儲存在本機，網路恢復後會自動上傳' });
      updateSyncHealthStatus();
    } finally {
      voiceUploadCount = Math.max(0, voiceUploadCount - 1);
      voiceUploadInFlight = voiceUploadCount > 0;
      schedulePendingSheetSync();
    }
  }

  function saveTransaction(event) {
    event.preventDefault();
    const errorElement = document.querySelector('#transaction-error');
    if (transactionForm.elements.type.value !== 'transfer' && !classificationReady) {
      applyLocalTransactionClassification();
    }
    const values = Object.fromEntries(new FormData(transactionForm));
    const input = {
      ...values,
      amount: Number(values.amount),
      fee: values.fee === '' ? 0 : Number(values.fee),
    };
    try {
      const features = rememberCategoryRule(input, normalizeFeatureSettings(state.featureSettings));
      const candidate = values.id ? input : applyCategoryRules(input, features.categoryRules || []);
      const transactions = values.id
        ? updateTransaction(state.transactions, values.id, input)
        : [...state.transactions, createTransaction(candidate)];
      if (!persist({ ...state, transactions, featureSettings: features })) return;
      if (!values.id) clearEntryDraft(localStorage);
      setSyncStatus('local', { detail: '已儲存在本機，尚未同步這次修改' });
      transactionDialog.close();
      render();
      showToast(values.id ? '已更新這筆記錄。' : '記下來了。');
    } catch (error) {
      errorElement.textContent = error instanceof ValidationError ? error.message : '儲存失敗，請再試一次。';
      errorElement.hidden = false;
    }
  }

  async function waitForSheetIdle() {
    for (let attempt = 0; attempt < 150 && (sheetWriteInFlight || sheetPullInFlight || voiceUploadInFlight); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !(sheetWriteInFlight || sheetPullInFlight || voiceUploadInFlight);
  }

  async function deleteTransaction(id) {
    const transaction = state.transactions.find(item => item.id === id);
    if (!transaction) return;
    const name = transaction.name || transaction.note || '這筆記錄';
    if (state.transactions.some(item => item.refundOf === id)) {
      showToast('請先解除這筆消費的退款連結，再刪除原消費。', 'error');
      return;
    }
    if (!confirm(`確定要刪除「${name}」嗎？刪除會在背景同步，短時間內可復原。`)) return;
    if (!persist({ ...state, transactions: removeTransaction(state.transactions, id) })) return;
    deletedDuringSession.add(id);
    render();
    showToast('已刪除，稍後自動同步。', 'default', { label: '復原', handler: () => {
      if (state.transactions.some(item => item.id === id)) return;
      const restored = { ...transaction, updatedAt: new Date().toISOString() };
      if (!persist({ ...state, transactions: [...state.transactions, restored] })) return;
      deletedDuringSession.delete(id);
      render();
      showToast('已復原原本這筆記錄。');
    } });
  }

  async function deleteBudget(category) {
    if (!confirm(`確定要移除「${category}」預算嗎？這會一併刪除 Google Sheet 中的預算資料。`)) return;
    const credentials = proxySession();
    if (!credentials.bound) {
      showToast('這台裝置尚未綁定 Google Sheet，無法確認同步刪除。', 'error');
      return;
    }
    if (!await waitForSheetIdle()) {
      showToast('更新尚未完成，稍後會自動接續。');
      return;
    }
    sheetWriteInFlight = true;
    try {
      await deleteLedgerBudgetFromSheet({ ...credentials, category });
    } catch (error) {
      setSyncStatus('error', { detail: `Sheet 刪除失敗：${error.message}` });
      showToast(`尚未移除預算：${error.message}`, 'error');
      return;
    } finally {
      sheetWriteInFlight = false;
    }
    if (!persist({ ...state, budgets: removeBudget(state.budgets, category) })) return;
    rememberProxySession(credentials.endpoint, credentials.proxyToken);
    rememberSuccessfulSync();
    render();
    showToast('已從本機與 Google Sheet 移除預算。');
  }

  function formatDetailTimestamp(value) {
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) return '—';
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(timestamp);
  }

  function openTransactionDetail(transactionId) {
    const transaction = state.transactions.find(item => item.id === transactionId);
    if (!transaction) return;
    const accounts = Object.fromEntries(state.accounts.map(account => [account.id, account.name]));
    const isTransfer = transaction.type === 'transfer';
    const transfer = isTransfer ? transferAmounts(transaction) : null;
    const category = isTransfer
      ? '轉帳'
      : [transaction.category, transaction.subcategory].filter(Boolean).join(' · ') || '未分類';
    const account = isTransfer
      ? `${accounts[transaction.account] || transaction.account} → ${accounts[transaction.toAccount] || transaction.toAccount}`
      : accounts[transaction.account] || transaction.account;
    const amount = `${transaction.type === 'expense' ? '-' : transaction.type === 'income' ? '+' : ''}${formatMoney(transaction.amount)}`;
    const aiChanges = Array.isArray(transaction.aiChanges) ? transaction.aiChanges : [];
    const signals = findTransactionSignals(state.transactions);
    const attentionReasons = [
      signals.duplicates.get(transaction.id),
      signals.anomalies.get(transaction.id),
    ].filter(Boolean);
    const groupCount = transaction.groupId
      ? state.transactions.filter(item => item.groupId === transaction.groupId).length
      : 0;
    const detailDialog = document.querySelector('#transaction-detail-dialog');
    detailDialog.querySelector('#transaction-detail-title').textContent = transaction.name || '交易詳情';
    detailDialog.querySelector('#transaction-detail-content').innerHTML = `
      <dl class="transaction-detail-list">
        <div><dt>類型</dt><dd>${escapeHtml(transaction.type === 'expense' ? '支出' : transaction.type === 'income' ? '收入' : '轉帳')}</dd></div>
        <div><dt>金額</dt><dd class="${escapeHtml(transaction.type)}">${escapeHtml(amount)}</dd></div>
        <div><dt>分類</dt><dd>${escapeHtml(category)}</dd></div>
        <div><dt>帳戶</dt><dd>${escapeHtml(account)}</dd></div>
        <div><dt>交易日期</dt><dd>${escapeHtml(transaction.date)}</dd></div>
        <div><dt>備註</dt><dd>${escapeHtml(transaction.note || '—')}</dd></div>
        ${attentionReasons.length ? `<div><dt>需確認原因</dt><dd>${escapeHtml(attentionReasons.join('、'))}</dd></div>` : ''}
        ${transfer ? `<div><dt>總扣款</dt><dd>${escapeHtml(formatMoney(transfer.debit))}</dd></div><div><dt>實收</dt><dd>${escapeHtml(formatMoney(transfer.credit))}</dd></div>` : ''}
        ${transaction.fee ? `<div><dt>轉帳手續費</dt><dd>${transaction.feeMode === 'included' ? '內扣' : '外加'} ${escapeHtml(formatMoney(transaction.fee))}</dd></div>` : ''}
        ${groupCount > 1 ? `<div><dt>同段記帳</dt><dd>${groupCount} 筆</dd></div>` : ''}
        <div><dt>AI 審查</dt><dd>${escapeHtml(transaction.aiStatus === 'confirmed' ? '已人工確認' : transaction.aiStatus === 'reviewed' ? '已審查' : transaction.aiStatus === 'pending' ? '待審查' : '—')}</dd></div>
        ${aiChanges.length ? `<div><dt>AI 修正</dt><dd>${aiChanges.map(change => `${escapeHtml(change.field)}：${escapeHtml(change.before)} → ${escapeHtml(change.after)}`).join('<br />')}</dd></div>` : ''}
        ${transaction.userEditedAt ? `<div><dt>人工鎖定</dt><dd>已手動修改，AI 不會覆寫</dd></div>` : ''}
        <div><dt>建立時間</dt><dd>${escapeHtml(formatDetailTimestamp(transaction.createdAt))}</dd></div>
        <div><dt>最後更新</dt><dd>${escapeHtml(formatDetailTimestamp(transaction.updatedAt))}</dd></div>
      </dl>`;
    const refunds = state.transactions.filter(item => item.refundOf === transaction.id);
    if (transaction.type === 'expense' && refunds.length) {
      const refundTotal = refunds.reduce((sum, item) => sum + item.amount, 0);
      detailDialog.querySelector('#transaction-detail-content').insertAdjacentHTML('beforeend', `<p>原消費 ${escapeHtml(formatMoney(transaction.amount))} · 已退款 ${escapeHtml(formatMoney(refundTotal))} · 淨支出 ${escapeHtml(formatMoney(transaction.amount - refundTotal))}</p>${refunds.map(item => `<button type="button" data-detail-id="${escapeHtml(item.id)}">查看退款 ${escapeHtml(formatMoney(item.amount))}</button>`).join('')}`);
    }
    if (transaction.type === 'income') {
      const candidates = state.transactions.filter(item => item.type === 'expense' && item.category !== '帳務調整' && item.date <= transaction.date);
      detailDialog.querySelector('#transaction-detail-content').insertAdjacentHTML('beforeend', `<form id="refund-link-form" data-refund-id="${escapeHtml(transaction.id)}"><label>連結原消費（退款不計收入）<select name="originalId"><option value="">不連結退款</option>${candidates.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === transaction.refundOf ? 'selected' : ''}>${escapeHtml(item.date)} · ${escapeHtml(item.name)} · ${escapeHtml(formatMoney(item.amount))}</option>`).join('')}</select></label><button class="secondary-button" type="submit">儲存退款連結</button></form>`);
    }
    detailDialog.querySelector('#transaction-detail-content').insertAdjacentHTML('beforeend', `<div class="sheet-sync-actions"><button class="secondary-button" type="button" data-edit-id="${escapeHtml(transaction.id)}">編輯這筆</button><button class="secondary-button" type="button" data-delete-id="${escapeHtml(transaction.id)}">刪除</button></div>`);
    if (attentionReasons.length) {
      detailDialog.querySelector('#transaction-detail-content').insertAdjacentHTML(
        'beforeend',
        `<button class="secondary-button detail-confirm-button" type="button" data-confirm-attention-id="${escapeHtml(transaction.id)}">確認無誤</button>`,
      );
    }
    if (!detailDialog.open) detailDialog.showModal();
  }

  function openWorkspaceDialog(title, html, mode = '') {
    document.querySelector('#workspace-dialog-title').textContent = title;
    document.querySelector('#workspace-dialog-content').innerHTML = html;
    const dialog = document.querySelector('#workspace-dialog');
    dialog.dataset.mode = mode;
    if (!dialog.open) {
      dialog.dataset.returnScroll = String(window.scrollY);
      dialog.showModal();
    }
  }

  function transactionDrillRows(transactions, kind = '') {
    const accounts = Object.fromEntries(state.accounts.map(item => [item.id, item.name]));
    return transactions.length ? `<div class="drill-transactions">${transactions.toSorted((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt))).map(item => {
      const expenseDrill = kind === 'expense' || kind === 'merchant';
      const contribution = expenseDrill ? expenseAmount(item) : item.amount;
      const sign = expenseDrill ? contribution < 0 ? '+' : '-' : item.type === 'expense' ? '-' : item.type === 'income' ? '+' : '';
      const name = `${item.name || '未命名'}${expenseDrill && item.type === 'transfer' ? '（手續費）' : item.refundOf ? '（退款）' : ''}`;
      return `<button type="button" data-detail-id="${escapeHtml(item.id)}"><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml([item.date, item.category, item.subcategory, accounts[item.account]].filter(Boolean).join(' · '))}</small></span><strong>${sign}${escapeHtml(formatMoney(Math.abs(contribution)))}</strong></button>`;
    }).join('')}</div>` : '<p class="empty-state">這個篩選沒有交易。</p>';
  }

  function openChartDrill(target) {
    const filters = target.dataset;
    const workspace = buildAnalysisWorkspace(state.transactions, { period: insightFilters.period, selectedMonth, today: insightFilters.anchorDate, currentDate: todayInTaipei(), category: insightFilters.category, subcategory: insightFilters.subcategory });
    const range = workspace.range;
    const kind = filters.analysisDrill || insightFilters.section;
    const start = filters.start || range.from;
    const end = filters.end || range.to;
    const transactions = state.transactions.filter(item => {
      if (item.date < start || item.date > end) return false;
      if (filters.date && !item.date.startsWith(filters.date)) return false;
      if (filters.month && !item.date.startsWith(filters.month)) return false;
      if (filters.category && (kind === 'expense' || kind === 'merchant' ? expenseCategory(item) : item.category) !== filters.category) return false;
      if (filters.subcategory && (kind === 'expense' && item.type === 'transfer' ? '轉帳手續費' : item.subcategory || '未細分') !== filters.subcategory) return false;
      if (filters.account && item.account !== filters.account && item.toAccount !== filters.account) return false;
      if (filters.accountGroup === 'liquid' && item.account === 'investment' && (item.type !== 'transfer' || item.toAccount === 'investment')) return false;
      if (filters.accountGroup === 'investment' && item.account !== 'investment' && (item.type !== 'transfer' || item.toAccount !== 'investment')) return false;
      if (filters.merchant && item.merchant !== filters.merchant) return false;
      if (filters.name && (item.merchant || item.itemName || item.name || '未命名') !== filters.name) return false;
      if ((kind === 'expense' || kind === 'merchant') && !expenseAmount(item)) return false;
      if (kind === 'income' && !incomeAmount(item)) return false;
      if (kind === 'living' && !incomeAmount(item) && !expenseAmount(item)) return false;
      if (kind === 'investment' && !isInvestmentTransfer(item)) return false;
      return true;
    });
    const title = filters.label || [filters.category, filters.subcategory, filters.date || filters.month].filter(Boolean).join(' › ') || '所選資料';
    openWorkspaceDialog('圖表交易明細', `<p>${escapeHtml(title)} · ${transactions.length} 筆${filters.accountGroup ? '（餘額另含初始金額）' : ''}</p>${transactionDrillRows(transactions, kind)}`);
  }

  function openBulkEdit() {
    if (!historySelection.ids.length) return;
    const selected = state.transactions.filter(item => historySelection.ids.includes(item.id));
    const types = new Set(selected.map(item => item.refundOf ? 'expense' : item.type));
    const commonType = types.size === 1 ? [...types][0] : '';
    const categories = commonType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    openWorkspaceDialog('批次修改', `<form id="bulk-edit-form"><p>已選 ${selected.length} 筆。留空的欄位保持原樣。</p><label>大分類<select name="category" ${!commonType || commonType === 'transfer' ? 'disabled' : ''}><option value="">不修改</option>${categories.map(item => `<option>${escapeHtml(item)}</option>`).join('')}</select></label><label>小分類<select name="subcategory" disabled><option value="">不修改</option></select></label><label>帳戶<select name="account"><option value="">不修改</option>${renderAccountOptions(state.accounts, '')}</select></label><p class="form-error" role="alert" hidden></p><button class="primary-button" type="submit">套用 ${selected.length} 筆</button></form>`);
    const form = document.querySelector('#bulk-edit-form');
    form.elements.category.addEventListener('change', () => {
      const category = form.elements.category.value;
      form.elements.subcategory.disabled = !category;
      form.elements.subcategory.innerHTML = category ? getSubcategories(category, commonType).map(item => `<option>${escapeHtml(item)}</option>`).join('') : '<option value="">不修改</option>';
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      try {
        const patch = Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ''));
        if (!Object.keys(patch).length) throw new Error('請選擇至少一個要修改的欄位');
        const transactions = bulkUpdateTransactions(state.transactions, historySelection.ids, patch, state.accounts);
        if (!persist({ ...state, transactions })) return;
        document.querySelector('#workspace-dialog').close();
        historySelection = { enabled: false, ids: [] };
        render();
        showToast('已批次修改，稍後同步。');
      } catch (error) { const output = form.querySelector('.form-error'); output.textContent = error.message; output.hidden = false; }
    });
  }

  function confirmTransactionAttention(id) {
    const transaction = state.transactions.find(item => item.id === id);
    if (!transaction) return;
    const signals = findTransactionSignals(state.transactions);
    const hasAttention = signals.duplicates.has(id) || signals.anomalies.has(id);
    if (!hasAttention) {
      showToast('這筆已不需要確認。');
      return;
    }
    try {
      const transactions = updateTransaction(state.transactions, id, { aiStatus: 'confirmed' }, {
        now: new Date().toISOString(),
      });
      if (!persist({ ...state, transactions })) return;
      setSyncStatus('local', { detail: '已確認無誤，正在同步到 Sheet' });
      document.querySelector('#transaction-detail-dialog').close();
      render();
      showToast('已確認無誤，已從待確認清單移除。');
    } catch (error) {
      showToast(error instanceof ValidationError ? error.message : '確認失敗，請再試一次。', 'error');
    }
  }

  function handleMainClick(event) {
    const target = event.target.closest('button');
    if (!target) return;
    if (Object.hasOwn(target.dataset, 'analysisDrill')) { openChartDrill(target); return; }
    if (Object.hasOwn(target.dataset, 'insightCompareSubcategory')) {
      const value = target.dataset.insightCompareSubcategory;
      const selected = insightFilters.compareSubcategories || [];
      insightFilters = { ...insightFilters, compareSubcategories: selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value] };
      render();
      [...main.querySelectorAll('[data-insight-compare-subcategory]')]
        .find(button => button.dataset.insightCompareSubcategory === value)?.focus({ preventScroll: true });
      return;
    }
    if (Object.hasOwn(target.dataset, 'bulkToggle')) {
      historySelection = { enabled: !historySelection.enabled, ids: [] };
      render();
      return;
    }
    if (Object.hasOwn(target.dataset, 'bulkClear')) { historySelection.ids = []; render(); return; }
    if (Object.hasOwn(target.dataset, 'bulkEdit')) { openBulkEdit(); return; }
    if (target.dataset.accountHistory) {
      openWorkspaceDialog('帳戶與對帳紀錄', renderAccountHistory(state, target.dataset.accountHistory));
      return;
    }
    if (Object.hasOwn(target.dataset, 'openInvestmentValuation')) {
      configureToolsForms();
      toolsDialog.showModal();
      const form = document.querySelector('#reconciliation-form');
      form.elements.accountId.value = 'investment';
      form.scrollIntoView({ block: 'center' });
      form.elements.actualBalance.focus();
      return;
    }
    if (target.dataset.insightPeriod) {
      insightFilters = {
        ...insightFilters,
        period: target.dataset.insightPeriod,
        selectedDate: '',
        anchorDate: insightFilters.anchorDate || todayInTaipei(),
      };
      render();
      return;
    }
    if (target.dataset.insightSection) {
      insightFilters = {
        ...insightFilters,
        section: target.dataset.insightSection,
        category: '',
        subcategory: '',
        compareSubcategories: [],
      };
      render();
      requestAnimationFrame(() => main.querySelector(`[data-insight-section="${target.dataset.insightSection}"]`)?.focus());
      return;
    }
    if (Object.hasOwn(target.dataset, 'insightCategory')) {
      const category = target.dataset.insightCategory || '';
      insightFilters = {
        ...insightFilters,
        category: insightFilters.category === category ? '' : category,
        subcategory: '',
        compareSubcategories: [],
      };
      render();
      (main.querySelector('.analysis-focus h2') || main.querySelector('[data-insight-category]'))?.focus({ preventScroll: true });
      return;
    }
    if (Object.hasOwn(target.dataset, 'insightSubcategory')) {
      const subcategory = target.dataset.insightSubcategory || '';
      insightFilters = {
        ...insightFilters,
        subcategory: insightFilters.subcategory === subcategory ? '' : subcategory,
      };
      render();
      main.querySelector('.analysis-focus h2')?.focus({ preventScroll: true });
      return;
    }
    if (target.dataset.insightShift) {
      const offset = Number(target.dataset.insightShift);
      if (insightFilters.period === 'week') {
        insightFilters = {
          ...insightFilters,
          selectedDate: '',
          anchorDate: shiftDate(insightFilters.anchorDate || todayInTaipei(), offset * 7),
        };
      } else {
        selectedMonth = shiftMonth(selectedMonth, insightFilters.period === 'year' ? offset * 12 : offset);
        insightFilters = { ...insightFilters, selectedDate: '' };
      }
      render();
      return;
    }
    if (target.dataset.insightMonth) {
      selectedMonth = target.dataset.insightMonth;
      insightFilters = { ...insightFilters, period: 'month', selectedDate: '', anchorDate: todayInTaipei() };
      render();
      return;
    }
    if (Object.hasOwn(target.dataset, 'insightDate')) {
      insightFilters = { ...insightFilters, selectedDate: target.dataset.insightDate || '' };
      render();
      return;
    }
    if (target.dataset.historyPreset) {
      historyFilters = { ...historyFilters, preset: target.dataset.historyPreset };
      if (target.dataset.goView) {
        const targetMonth = latestPresetMonth(state.transactions, target.dataset.historyPreset);
        if (targetMonth) selectedMonth = targetMonth;
        navigate(target.dataset.goView);
        requestAnimationFrame(() => main.querySelector(`[data-history-preset="${target.dataset.historyPreset}"]`)?.focus());
      } else {
        render();
        requestAnimationFrame(() => main.querySelector(`[data-history-preset="${target.dataset.historyPreset}"]`)?.focus());
      }
      return;
    }
    if (target.dataset.historyFilter) {
      const key = target.dataset.historyFilter;
      if (!['type', 'category', 'subcategory', 'account', 'query'].includes(key)) return;
      const value = target.dataset.historyValue || '';
      historyFilters = {
        ...historyFilters,
        [key]: value,
        ...(key === 'category' ? { subcategory: '' } : {}),
        ...(key === 'type' ? { category: '', subcategory: '' } : {}),
      };
      render();
      requestAnimationFrame(() =>
        main
          .querySelector(`[data-history-filter="${CSS.escape(key)}"][data-history-value="${CSS.escape(value)}"]`)
          ?.focus(),
      );
      return;
    }
    if (target.dataset.historyMonthScope) {
      historyFilters = { ...historyFilters, monthScope: target.dataset.historyMonthScope };
      render();
      return;
    }
    if (target.dataset.goView) navigate(target.dataset.goView);
    if (target.dataset.detailId) {
      openTransactionDetail(target.dataset.detailId);
      return;
    }
    if (target.dataset.monthShift) {
      selectedMonth = shiftMonth(selectedMonth, Number(target.dataset.monthShift));
      render();
    }
    if (target.dataset.editId) {
      openTransactionDialog(state.transactions.find(item => item.id === target.dataset.editId));
    }
    if (target.dataset.deleteId) {
      void deleteTransaction(target.dataset.deleteId);
      return;
    }
    if (target.dataset.removeBudget) {
      void deleteBudget(target.dataset.removeBudget);
      return;
    }
  }

  function handleHistoryFilters(event) {
    if (event.target.id !== 'history-search') return;
    historyFilters = {
      query: document.querySelector('#history-search')?.value || '',
      type: historyFilters.type,
      category: historyFilters.category,
      subcategory: historyFilters.subcategory,
      account: historyFilters.account,
      preset: historyFilters.preset,
      monthScope: historyFilters.monthScope,
    };
    render();
    if (event.target.id === 'history-search') {
      const input = document.querySelector('#history-search');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function saveBudget(event) {
    if (event.target.id !== 'budget-form') return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    try {
      if (!persist({ ...state, budgets: upsertBudget(state.budgets, { ...values, limit: Number(values.limit) }) })) return;
      render();
      showToast('預算已儲存。');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function exportData(format) {
    const date = todayInTaipei();
    if (format === 'json') {
      downloadText(`hukeep-personal-${date}.json`, serializeBackup(state), 'application/json');
    } else {
      const monthly = format === 'month-csv';
      const transactions = monthly
        ? filterTransactions(state.transactions, { month: selectedMonth })
        : state.transactions;
      downloadText(
        `hukeep-personal-${monthly ? selectedMonth : date}.csv`,
        transactionsToCsv(transactions),
        'text/csv;charset=utf-8',
      );
    }
    showToast('備份已開始下載。');
  }

  async function importData(file) {
    if (!file) return;
    try {
      const imported = parseBackup(await file.text());
      const difference = previewBackupRestore(state, imported);
      pendingBackup = imported;
      document.querySelector('#backup-preview-content').innerHTML = Object.entries({
        transactions: '交易', accounts: '帳戶', budgets: '預算',
        recurringRules: '固定流水', monthlySnapshots: '月結', reconciliations: '對帳', preferences: '偏好設定',
      }).map(([key, label]) => `<article><strong>${label}</strong><span>新增 ${difference[key].added} · 修改 ${difference[key].changed} · 移除 ${difference[key].removed}</span></article>`).join('');
      document.querySelector('#backup-preview-confirm').disabled = !difference.hasChanges;
      document.querySelector('#backup-preview-dialog').showModal();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function confirmBackupRestore() {
    if (!pendingBackup) return;
    downloadText(`hukeep-personal-before-import-${todayInTaipei()}.json`, serializeBackup(state), 'application/json');
    if (!persist(pendingBackup)) return;
    const count = pendingBackup.transactions.length;
    pendingBackup = null;
    document.querySelector('#backup-preview-dialog').close();
    toolsDialog.close();
    render();
    showToast(`已還原 ${count} 筆記錄。`);
  }


  function configureToolsForms() {
    renderCategoryRules();
    const fields = document.querySelector('#opening-balance-fields');
    fields.innerHTML = state.accounts
      .map(
        account => `<label><span>${escapeHtml(account.name)}初始金額</span><input name="${escapeHtml(account.id)}" type="number" step="1" inputmode="numeric" value="${account.openingBalance}" required /></label>`,
      )
      .join('');
    const recurringForm = document.querySelector('#recurring-rule-form');
    const reconciliationForm = document.querySelector('#reconciliation-form');
    const accountOptionsHtml = state.accounts
      .map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`)
      .join('');
    recurringForm.elements.account.innerHTML = accountOptionsHtml;
    recurringForm.elements.toAccount.innerHTML = accountOptionsHtml;
    if (!recurringForm.elements.startDate.value) recurringForm.elements.startDate.value = todayInTaipei();
    configureRecurringFields();
    reconciliationForm.elements.accountId.innerHTML = accountOptionsHtml;
    if (!reconciliationForm.elements.date.value) reconciliationForm.elements.date.value = todayInTaipei();
    renderRecurringRules();
    renderReconciliations();
    const sheetStatus = document.querySelector('#sheet-sync-status');
    if (sheetStatus && !sheetStatus.classList.contains('error')) {
      const lastAt = storedLastSyncAt();
      sheetStatus.textContent = sheetConfigurationNotice || (lastAt
        ? `上次同步：${formatDetailTimestamp(lastAt)}`
        : '尚未成功同步。');
    }
    updateSyncHealthStatus();
    updateDeviceBindingStatus();
  }

  function configureRecurringFields() {
    const form = document.querySelector('#recurring-rule-form');
    const type = form.elements.type.value;
    const transfer = type === 'transfer';
    const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    form.querySelector('.recurring-category').hidden = transfer;
    form.querySelector('.recurring-to-account').hidden = !transfer;
    form.querySelector('.recurring-fee').hidden = !transfer;
    form.querySelector('.recurring-fee-mode').hidden = !transfer;
    const preview = document.querySelector('#recurring-transfer-preview');
    preview.hidden = !transfer;
    updateTransferPreview(form, preview);
    form.elements.category.required = !transfer;
    form.elements.toAccount.required = transfer;
    form.elements.category.innerHTML = transfer
      ? ''
      : categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    [...form.elements.toAccount.options].forEach(option => {
      option.disabled = option.value === form.elements.account.value;
    });
    if (form.elements.toAccount.value === form.elements.account.value) {
      form.elements.toAccount.value = state.accounts.find(account => account.id !== form.elements.account.value)?.id || '';
    }
  }

  function renderRecurringRules() {
    const list = document.querySelector('#recurring-rule-list');
    const rules = normalizeFeatureSettings(state.featureSettings).recurringRules;
    list.innerHTML = rules.length
      ? rules.map(rule => `<article><div><strong>${escapeHtml(rule.name)}</strong><span>${escapeHtml(rule.cadence === 'weekly' ? '每週' : `每月 ${rule.day} 日`)} · ${formatMoney(rule.amount)} · ${rule.enabled ? '啟用' : '暫停'}</span></div><button type="button" data-edit-recurring="${escapeHtml(rule.id)}">編輯</button><button type="button" data-toggle-recurring="${escapeHtml(rule.id)}">${rule.enabled ? '暫停' : '啟用'}</button><button type="button" data-remove-recurring="${escapeHtml(rule.id)}" aria-label="刪除 ${escapeHtml(rule.name)}">×</button></article>`).join('')
      : '<p class="settings-empty">尚未設定固定流水。</p>';
  }

  function renderReconciliations() {
    const list = document.querySelector('#reconciliation-list');
    const accounts = Object.fromEntries(state.accounts.map(account => [account.id, account]));
    const reconciliations = normalizeFeatureSettings(state.featureSettings).reconciliations
      .toSorted((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    list.innerHTML = reconciliations.length
      ? reconciliations.slice(0, 10).map(item => {
        const { estimatedBalance: estimated, difference, adjustment, corrected } = reconciliationAdjustmentStatus(state, item);
        const detail = item.accountId === 'investment'
          ? `市值 ${formatMoney(item.actualBalance)}`
          : `帳本 ${formatMoney(estimated ?? 0)} · 實際 ${formatMoney(item.actualBalance)} · ${difference === 0 ? '一致' : `差額 ${formatMoney(difference)}`}`;
        return `<article><div><strong>${escapeHtml(accounts[item.accountId]?.name || item.accountId)} · ${escapeHtml(item.date)} 已對帳</strong><span>${detail}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</span></div>${(difference !== 0 || adjustment) && item.accountId !== 'investment' ? `<button type="button" data-adjust-reconciliation="${escapeHtml(item.id)}" ${corrected ? 'disabled' : ''}>${corrected ? '已調整' : adjustment ? '更新差額調整' : '建立差額調整'}</button>` : ''}</article>`;
      }).join('')
      : '<p class="settings-empty">尚未儲存對帳結果。</p>';
  }

  function renderCategoryRules() {
    const rules = normalizeFeatureSettings(state.featureSettings).categoryRules || [];
    document.querySelector('#category-rules-list').innerHTML = rules.length ? rules.map(item => `<article><div><strong>${escapeHtml(item.match)}</strong><span>${escapeHtml([item.type === 'income' ? '收入' : '支出', item.category, item.subcategory].join(' · '))}</span></div><button type="button" data-remove-category-rule="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.match)} 分類規則">×</button></article>`).join('') : '<p>尚未設定規則；在手動記帳時可選擇記住分類。</p>';
  }

  function updateSyncHealthStatus() {
    const status = document.querySelector('#sync-health-status');
    if (!status) return;
    const pending = readPendingSheetChanges();
    const queued = [pending.upserts, pending.deletes, pending.accountUpserts, pending.accountDeletes, pending.budgetUpserts, pending.budgetDeletes,
      ...Object.values(pending.featureUpserts || {}), ...Object.values(pending.featureDeletes || {})]
      .reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0) + (pending.features && ![
        ...Object.values(pending.featureUpserts || {}), ...Object.values(pending.featureDeletes || {}),
      ].some(values => values.length) ? 1 : 0);
    const review = state.transactions.filter(transaction => transaction.aiStatus === 'pending').length;
    const lastAt = storedLastSyncAt();
    const lastLabel = lastAt ? `最後同步 ${formatDetailTimestamp(lastAt)}` : '尚未成功同步';
    const next = queued && nextSheetRetryAt > Date.now()
      ? ` · 下次重試 ${formatDetailTimestamp(nextSheetRetryAt)}` : '';
    const first = pending.upserts[0];
    const item = first ? ` · 下一筆交易 #${String(first).slice(-8)}` : '';
    status.textContent = `${lastLabel} · 待上傳 ${queued} 項${item}${next} · AI 待審 ${review} 筆`;
    const inspector = document.querySelector('#workspace-dialog');
    if (inspector.open && inspector.dataset.mode === 'sync') document.querySelector('#workspace-dialog-content').innerHTML = renderSyncInspector(state, pending, { now: Date.now() });
  }

  function saveRecurringRule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const featureSettings = normalizeFeatureSettings(state.featureSettings);
    const existing = featureSettings.recurringRules.find(rule => rule.id === values.id);
    const rule = {
      ...values,
      id: existing?.id || globalThis.crypto?.randomUUID?.() || `rule-${Date.now()}`,
      amount: Number(values.amount),
      day: Number(values.day),
      fee: Number(values.fee || 0),
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    let nextFeatures;
    try {
      nextFeatures = upsertRecurringRule(featureSettings, rule);
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
    if (!persist({ ...state, featureSettings: nextFeatures })) return;
    applyDueRecurringTransactions();
    cancelRecurringEdit();
    configureToolsForms();
    render();
    showToast(existing ? '固定流水已更新，過去交易不變。' : '固定流水已儲存。');
  }

  function cancelRecurringEdit() {
    const form = document.querySelector('#recurring-rule-form');
    form.reset();
    form.elements.id.value = '';
    form.elements.startDate.value = todayInTaipei();
    form.querySelector('button[type="submit"]').textContent = '新增固定流水';
    document.querySelector('#recurring-edit-cancel').hidden = true;
    configureRecurringFields();
  }

  function editRecurringRule(id) {
    const rule = normalizeFeatureSettings(state.featureSettings).recurringRules.find(item => item.id === id);
    if (!rule) return;
    const form = document.querySelector('#recurring-rule-form');
    for (const key of ['id', 'name', 'amount', 'type', 'cadence', 'day', 'startDate', 'account', 'toAccount', 'fee', 'note']) {
      if (form.elements[key]) form.elements[key].value = rule[key] ?? '';
    }
    form.elements.feeMode.value = rule.type === 'transfer' ? rule.feeMode || 'additional' : 'included';
    configureRecurringFields();
    form.elements.category.value = rule.category || '';
    form.querySelector('button[type="submit"]').textContent = '儲存修改';
    document.querySelector('#recurring-edit-cancel').hidden = false;
    form.scrollIntoView({ block: 'center' });
  }

  function toggleRecurringRule(id) {
    const settings = normalizeFeatureSettings(state.featureSettings);
    const rule = settings.recurringRules.find(item => item.id === id);
    if (!rule) return;
    let next = setRecurringRuleEnabled(settings, id, !rule.enabled);
    if (!rule.enabled && rule.startDate < todayInTaipei()) {
      next = upsertRecurringRule(next, { ...next.recurringRules.find(item => item.id === id), startDate: todayInTaipei() });
    }
    if (!persist({ ...state, featureSettings: next })) return;
    if (!rule.enabled) applyDueRecurringTransactions();
    renderRecurringRules();
    showToast(rule.enabled ? '已暫停固定流水，過去交易保留。' : '已啟用固定流水，從今天起恢復。');
  }

  function saveReconciliation(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const featureSettings = normalizeFeatureSettings(state.featureSettings);
    const createdAt = new Date().toISOString();
    const item = {
      ...values,
      id: globalThis.crypto?.randomUUID?.() || `reconcile-${Date.now()}`,
      actualBalance: Number(values.actualBalance),
      estimatedBalance: calculateAccountBalances(
        state.accounts, transactionsAtReconciliation(state.transactions, { date: values.date, createdAt }),
      ).find(account => account.id === values.accountId)?.balance,
      createdAt,
    };
    const nextFeatures = normalizeFeatureSettings({
      ...featureSettings,
      reconciliations: [...featureSettings.reconciliations, item],
    });
    if (nextFeatures.reconciliations.length !== featureSettings.reconciliations.length + 1) {
      showToast('對帳資料不完整，請檢查帳戶、餘額與日期。', 'error');
      return;
    }
    if (!persist({ ...state, featureSettings: nextFeatures })) return;
    event.currentTarget.reset();
    configureToolsForms();
    render();
    showToast('對帳結果已儲存。');
  }

  async function createReconciliationAdjustment(id) {
    const item = normalizeFeatureSettings(state.featureSettings).reconciliations.find(entry => entry.id === id);
    if (!item || item.accountId === 'investment') return;
    const { difference, adjustment, corrected } = reconciliationAdjustmentStatus(state, item);
    if (corrected || (!difference && !adjustment)) return;
    if (!confirm(difference
      ? `要${adjustment ? '更新' : '建立'} ${formatMoney(Math.abs(difference))} 的帳務調整嗎？這會修正帳戶餘額，但不計入生活收支。`
      : '要移除已不需要的帳務調整嗎？')) return;
    try {
      const txId = adjustment?.id || await reconciliationAdjustmentId(id);
      const transaction = difference ? createTransaction({
        type: difference > 0 ? 'income' : 'expense',
        name: '對帳調整', amount: Math.abs(difference), account: item.accountId,
        category: '帳務調整', subcategory: '餘額差額', date: item.date,
        note: reconciliationAdjustmentNote(item), source: 'manual',
      }, { id: txId }) : null;
      if (!persist({ ...state, transactions: [
        ...state.transactions.filter(tx => tx.id !== txId), ...(transaction ? [transaction] : []),
      ] })) return;
      render();
      showToast('已建立帳務調整，生活收支不受影響。');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function removeRecurringRule(id) {
    const featureSettings = normalizeFeatureSettings(state.featureSettings);
    const rule = featureSettings.recurringRules.find(item => item.id === id);
    if (!rule || !confirm(`確定要刪除固定流水「${rule.name}」嗎？已建立的交易會保留。`)) return;
    if (!persist({
      ...state,
      featureSettings: {
        ...featureSettings,
        recurringRules: featureSettings.recurringRules.filter(item => item.id !== id),
      },
    })) return;
    configureToolsForms();
    render();
    showToast('固定流水已刪除。');
  }

  function saveOpeningBalances(event) {
    event.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const accounts = updateOpeningBalances(state.accounts, values);
      if (!persist({ ...state, accounts })) return;
      setSyncStatus('local', { detail: '初始金額已儲存在本機，尚未同步' });
      render();
      showToast('帳戶初始金額已儲存。');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function schedulePendingSheetSync(delay = AUTO_SYNC_DEBOUNCE_MS) {
    clearTimeout(pendingSheetSyncTimer);
    if (document.hidden || navigator.onLine === false || !hasPendingSheetChanges(readPendingSheetChanges())) return;
    pendingSheetSyncTimer = setTimeout(() => {
      pendingSheetSyncTimer = null;
      void syncPendingSheetChanges();
    }, delay);
  }

  function schedulePendingSheetRetry() {
    pendingSheetRetryCount = Math.min(pendingSheetRetryCount + 1, 8);
    const delay = Math.min(
      SHEET_RETRY_BASE_DELAY_MS * (2 ** (pendingSheetRetryCount - 1)),
      SHEET_RETRY_MAX_DELAY_MS,
    );
    nextSheetRetryAt = Date.now() + delay;
    updateSyncHealthStatus();
    schedulePendingSheetSync(delay);
  }

  async function syncPendingSheetChanges() {
    const changes = readPendingSheetChanges();
    const stateAtRequest = repository.load();
    let completed = false;
    const credentials = proxySession();
    if (
      sheetWriteInFlight ||
      sheetPullInFlight ||
      voiceUploadInFlight ||
      document.hidden ||
      !hasPendingSheetChanges(changes) ||
      !credentials.bound
    ) {
      return false;
    }
    sheetWriteInFlight = true;
    setSyncStatus('syncing');
    try {
      await syncLedgerChangesToSheet({ ...credentials, state: stateAtRequest, changes });
      if (!writePendingSheetChanges(acknowledgePendingSheetChanges(
        readPendingSheetChanges(), changes, stateAtRequest, repository.load(),
      ))) throw new Error('無法儲存同步確認，資料會保持待同步');
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      rememberSuccessfulSync();
      completed = true;
      sheetConfigurationNotice = '';
      return true;
    } catch (error) {
      // Keep the local journal authoritative and retry quietly. The user can
      // continue using the app while the next online window drains the queue.
      setSyncStatus('local', { detail: '已儲存在本機，連線恢復後會自動上傳' });
      if (error.message.includes('GAS')) {
        sheetConfigurationNotice = error.message;
        document.querySelector('#sheet-sync-status').textContent = sheetConfigurationNotice;
      }
      schedulePendingSheetRetry();
      return false;
    } finally {
      sheetWriteInFlight = false;
      if (completed && state !== stateAtRequest && hasPendingSheetChanges(readPendingSheetChanges())) {
        // A local edit landed while this request was in flight. Drain it
        // immediately after the response so it cannot sit behind the normal
        // debounce window (and never gets folded into a duplicate retry).
        schedulePendingSheetSync(0);
      }
    }
  }

  function syncOnViewChange() {
    if (document.hidden) return;
    if (hasPendingSheetChanges(readPendingSheetChanges())) {
      void syncPendingSheetChanges().then(completed => {
        if (completed) void refreshSheetInBackground({ force: true });
      }).catch(() => schedulePendingSheetRetry());
      return;
    }
    void refreshSheetInBackground({ force: true });
  }

  async function syncSheet(event) {
    event.preventDefault();
    if (sheetWriteInFlight || sheetPullInFlight || voiceUploadInFlight) {
      if (!await waitForSheetIdle()) {
        showToast('更新尚未完成，稍後會自動接續。');
        return;
      }
    }
    const button = document.querySelector('#sheet-sync-button');
    const status = document.querySelector('#sheet-sync-status');
    const credentials = proxySession();
    if (!credentials.bound) {
      setSyncStatus('local', { detail: '本機資料已保留，綁定 Sheet 後會自動上傳' });
      showToast('尚未綁定 Google Sheet，已先保留本機資料。', 'error');
      return;
    }
    clearTimeout(pendingSheetSyncTimer);
    button.disabled = true;
    setSyncStatus('syncing');
    status.classList.remove('error');
    status.textContent = '正在更新資料…';
    try {
      if (hasPendingSheetChanges(readPendingSheetChanges()) && !await syncPendingSheetChanges()) {
        throw new Error('尚有資料未上傳，請稍後重試。');
      }
      sheetWriteInFlight = true;
      const remote = await loadStableSheetState(credentials);
      if (!persist(reconcileLedgerFromSheet(state, remote, readPendingSheetChanges()), { sheetSourced: true, protectPending: true })) return;
      queueInvestmentSheetDifferences(remote);
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      rememberSuccessfulSync();
      render();
      status.textContent = `同步完成：${state.accounts.length} 個帳戶、${state.transactions.length} 筆交易、${state.budgets.length} 筆預算。`;
      showToast('Google Sheet 同步完成。');
    } catch (error) {
      setSyncStatus('local', { detail: '本機資料已保留，連線恢復後會自動續傳' });
      status.classList.remove('error');
      status.textContent = `本機資料已保留，稍後會自動續傳。${error.message}`;
      schedulePendingSheetRetry();
      showToast('本機資料已保留，稍後會自動續傳。');
    } finally {
      sheetWriteInFlight = false;
      button.disabled = false;
      schedulePendingSheetSync();
    }
  }

  async function loadStableSheetState(credentials) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = state;
      const remote = await loadLedgerStateFromSheet(credentials);
      if (state === before) return remote;
    }
    throw new Error('讀取期間帳本仍在更新，請稍後再同步。');
  }

  async function loadSheet() {
    const syncButton = document.querySelector('#sheet-sync-button');
    const loadButton = document.querySelector('#sheet-load-button');
    const status = document.querySelector('#sheet-sync-status');
    const credentials = proxySession();
    if (!confirm('要從 Sheet 取回最新資料嗎？Sheet 已刪除的紀錄也會從網頁移除；尚未上傳的本機修改會保留。')) return;
    if (!credentials.bound) {
      showToast('尚未綁定 Google Sheet，已先保留本機資料。', 'error');
      return;
    }
    if (!await waitForSheetIdle()) {
      showToast('目前仍在更新資料，請稍後再讀取。');
      return;
    }
    sheetPullInFlight = true;
    syncButton.disabled = true;
    loadButton.disabled = true;
    setSyncStatus('syncing');
    status.classList.remove('error');
    status.textContent = '正在從 Sheet 讀取…';
    try {
      const sheetState = await loadStableSheetState({
        ...credentials,
      });
      const merged = reconcileLedgerFromSheet(state, sheetState, readPendingSheetChanges());
      if (!persist({
        ...merged,
        preferences: { ...merged.preferences, proxyEndpoint: credentials.endpoint },
      }, { sheetSourced: true, protectPending: true })) {
        return;
      }
      queueInvestmentSheetDifferences(sheetState);
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      rememberSuccessfulSync();
      render();
      status.textContent = `讀取完成：${state.accounts.length} 個帳戶、${state.transactions.length} 筆交易、${state.budgets.length} 筆預算。`;
      showToast('Google Sheet 資料已更新到本機。');
    } catch (error) {
      setSyncStatus(lastSheetPullAt ? 'synced' : 'local', { lastAt: lastSheetPullAt });
      status.classList.remove('error');
      status.textContent = `讀取暫緩，本機資料未變更。${error.message}`;
      scheduleBackgroundPullRetry();
      showToast('讀取暫緩，本機資料未變更。');
    } finally {
      syncButton.disabled = false;
      loadButton.disabled = false;
      sheetPullInFlight = false;
      schedulePendingSheetSync();
    }
  }

  function scheduleBackgroundPullRetry() {
    if (backgroundPullRetryTimer || document.hidden || navigator.onLine === false) return;
    backgroundPullRetryCount = Math.min(backgroundPullRetryCount + 1, 4);
    const delay = Math.min(SHEET_RETRY_BASE_DELAY_MS * (2 ** (backgroundPullRetryCount - 1)), 60_000);
    backgroundPullRetryTimer = setTimeout(() => {
      backgroundPullRetryTimer = null;
      void refreshSheetInBackground({ force: true });
    }, delay);
  }

  async function refreshSheetInBackground(options = {}) {
    const credentials = proxySession();
    const now = Date.now();
    if (
      sheetPullInFlight ||
      sheetWriteInFlight ||
      voiceUploadInFlight ||
      document.hidden ||
      !credentials.endpoint ||
      !credentials.proxyToken ||
      (!options.force && now - lastSheetPullAt < RESUME_PULL_THRESHOLD_MS)
    ) {
      return;
    }
    sheetPullInFlight = true;
    setSyncStatus('syncing');
    try {
      const remote = await loadStableSheetState(credentials);
      const reconciled = reconcileLedgerFromSheet(state, remote, readPendingSheetChanges());
      if (!persist(reconciled, { sheetSourced: true, protectPending: true })) return;
      queueInvestmentSheetDifferences(remote);
      rememberSuccessfulSync();
      render();
    } catch {
      // Background pulls are best-effort. Keep the last known good state and
      // try again later without flashing an alarming failure state.
      setSyncStatus(lastSheetPullAt ? 'synced' : 'local', { lastAt: lastSheetPullAt });
      scheduleBackgroundPullRetry();
    } finally {
      sheetPullInFlight = false;
      schedulePendingSheetSync();
    }
  }

  document.querySelectorAll('[data-nav-view]').forEach(button =>
    button.addEventListener('click', () => navigate(button.dataset.navView)),
  );
  document.querySelector('#quick-add-button').addEventListener('click', () => openTransactionDialog());
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    if (!persist({ ...state, preferences: { ...state.preferences, theme } })) return;
    applyTheme();
  });
  document.querySelector('#tools-button').addEventListener('click', () => {
    configureToolsForms();
    toolsDialog.showModal();
  });
  document.querySelector('#device-binding-share').addEventListener('click', openDeviceBindingDialog);
  document.querySelector('#device-binding-copy').addEventListener('click', copyDeviceBindingLink);
  document.querySelector('#device-pairing-claim-button').addEventListener('click', claimDeviceBinding);
  document.querySelector('#device-pairing-code').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      claimDeviceBinding();
    }
  });
  document.querySelector('#export-json').addEventListener('click', () => exportData('json'));
  document.querySelector('#export-csv').addEventListener('click', () => exportData('csv'));
  document.querySelector('#export-month-csv').addEventListener('click', () => exportData('month-csv'));
  document.querySelector('#import-json').addEventListener('change', event => {
    const input = event.target;
    importData(input.files?.[0]).finally(() => {
      input.value = '';
    });
  });
  document.querySelector('#backup-preview-confirm').addEventListener('click', confirmBackupRestore);
  document.querySelector('#backup-preview-cancel').addEventListener('click', () => document.querySelector('#backup-preview-dialog').close());
  document.querySelector('#backup-preview-dialog').addEventListener('close', () => { pendingBackup = null; });
  document.querySelector('#opening-balance-form').addEventListener('submit', saveOpeningBalances);
  document.querySelector('#recurring-rule-form').addEventListener('submit', saveRecurringRule);
  document.querySelector('#recurring-edit-cancel').addEventListener('click', cancelRecurringEdit);
  document.querySelector('#recurring-rule-form').elements.type.addEventListener('change', configureRecurringFields);
  document.querySelector('#recurring-rule-form').elements.account.addEventListener('change', configureRecurringFields);
  document.querySelector('#reconciliation-form').addEventListener('submit', saveReconciliation);
  toolsDialog.addEventListener('click', event => {
    const removeRule = event.target.closest('[data-remove-category-rule]');
    if (removeRule && confirm('確定移除這個分類規則？')) {
      const features = normalizeFeatureSettings(state.featureSettings);
      if (persist({ ...state, featureSettings: { ...features, categoryRules: features.categoryRules.filter(item => item.id !== removeRule.dataset.removeCategoryRule) } })) renderCategoryRules();
    }
    const remove = event.target.closest('[data-remove-recurring]');
    if (remove) removeRecurringRule(remove.dataset.removeRecurring);
    const edit = event.target.closest('[data-edit-recurring]');
    if (edit) editRecurringRule(edit.dataset.editRecurring);
    const toggle = event.target.closest('[data-toggle-recurring]');
    if (toggle) toggleRecurringRule(toggle.dataset.toggleRecurring);
    const adjustment = event.target.closest('[data-adjust-reconciliation]');
    if (adjustment) createReconciliationAdjustment(adjustment.dataset.adjustReconciliation);
  });
  document.querySelector('#sheet-sync-form').addEventListener('submit', syncSheet);
  document.querySelector('#sheet-load-button').addEventListener('click', loadSheet);
  document.querySelector('#sync-indicator').addEventListener('click', () => {
    configureToolsForms();
    toolsDialog.showModal();
    document.querySelector('#sheet-sync-title').scrollIntoView({ block: 'center' });
  });
  document.querySelectorAll('.dialog-close').forEach(button =>
    button.addEventListener('click', () => button.closest('dialog').close()),
  );
  document.querySelector('#transaction-detail-dialog').addEventListener('click', event => {
    const button = event.target.closest('[data-confirm-attention-id]');
    if (button) confirmTransactionAttention(button.dataset.confirmAttentionId);
    const target = event.target.closest('button');
    if (target?.dataset.editId) { document.querySelector('#transaction-detail-dialog').close(); openTransactionDialog(state.transactions.find(item => item.id === target.dataset.editId)); }
    if (target?.dataset.deleteId) { document.querySelector('#transaction-detail-dialog').close(); void deleteTransaction(target.dataset.deleteId); }
    if (target?.dataset.detailId) openTransactionDetail(target.dataset.detailId);
  });
  document.querySelector('#transaction-detail-dialog').addEventListener('submit', event => {
    const form = event.target.closest('#refund-link-form');
    if (!form) return;
    event.preventDefault();
    try {
      const transactions = linkRefund(state.transactions, form.dataset.refundId, form.elements.originalId.value);
      if (!persist({ ...state, transactions })) return;
      render();
      openTransactionDetail(form.dataset.refundId);
      showToast('已更新退款連結。');
    } catch (error) { showToast(error.message, 'error'); }
  });
  document.querySelector('#workspace-dialog').addEventListener('click', event => {
    const target = event.target.closest('button');
    if (target?.dataset.detailId) openTransactionDetail(target.dataset.detailId);
    if (Object.hasOwn(target?.dataset || {}, 'syncRetry')) {
      pendingSheetRetryCount = 0;
      void syncPendingSheetChanges();
      showToast('已安排重試；本機資料仍保留。');
    }
  });
  document.querySelector('#workspace-dialog').addEventListener('close', event => {
    const top = Number(event.target.dataset.returnScroll);
    if (Number.isFinite(top)) requestAnimationFrame(() => scrollTo({ top, behavior: 'instant' }));
  });
  document.querySelector('#inspect-pending-sync').addEventListener('click', () =>
    openWorkspaceDialog('待上傳項目', renderSyncInspector(state, readPendingSheetChanges(), { now: Date.now() }), 'sync'),
  );
  document.querySelector('#save-entry-template').addEventListener('click', saveEntryTemplate);
  document.querySelector('#discard-entry-draft').addEventListener('click', () => {
    clearEntryDraft(localStorage);
    openTransactionDialog();
    showToast('草稿已捨棄。');
  });
  document.querySelector('#entry-templates').addEventListener('click', event => {
    const apply = event.target.closest('[data-entry-template]');
    const remove = event.target.closest('[data-remove-entry-template]');
    const features = normalizeFeatureSettings(state.featureSettings);
    if (apply) {
      const template = (features.templates || []).find(item => item.id === apply.dataset.entryTemplate);
      if (!template) return;
      fillEntryForm({ ...template, date: todayInTaipei() });
      document.querySelector('#manual-entry').open = true;
      rememberEntryDraft();
    }
    if (remove && confirm('確定移除這個快速範本？')) {
      if (persist({ ...state, featureSettings: { ...features, templates: features.templates.filter(item => item.id !== remove.dataset.removeEntryTemplate) } })) renderEntryTemplates();
    }
  });
  transactionForm.addEventListener('input', rememberEntryDraft);
  transactionForm.addEventListener('change', rememberEntryDraft);
  transactionForm.addEventListener('click', () => queueMicrotask(rememberEntryDraft));
  document.querySelector('#manual-entry').addEventListener('toggle', rememberEntryDraft);
  window.addEventListener('pagehide', rememberEntryDraft);
  transactionForm.addEventListener('submit', saveTransaction);
  transactionForm.addEventListener('input', event => {
    if (['amount', 'fee', 'feeMode'].includes(event.target.name)) updateTransferPreview(transactionForm, document.querySelector('#transfer-preview'));
  });
  const recurringForm = document.querySelector('#recurring-rule-form');
  recurringForm.addEventListener('input', event => {
    if (['amount', 'fee', 'feeMode'].includes(event.target.name)) updateTransferPreview(recurringForm, document.querySelector('#recurring-transfer-preview'));
  });
  transactionForm.addEventListener('click', event => {
    const button = event.target.closest('[data-transaction-type]');
    if (button) {
      manualCategoryChosen = false;
      setTransactionType(button.dataset.transactionType);
      scheduleTransactionClassification();
    }
    const accountButton = event.target.closest('[data-account-value]');
    if (accountButton && !accountButton.disabled) {
      const select = transactionForm.querySelector(`#${accountButton.dataset.accountFor}`);
      if (!select) return;
      select.value = accountButton.dataset.accountValue;
      if (select === transactionForm.elements.account) {
        updateDestinationAccounts(transactionForm.elements.toAccount.value);
      } else {
        syncAccountButtons(select, transactionForm.elements.account.value);
      }
    }
  });
  transactionForm.elements.account.addEventListener('change', () =>
    updateDestinationAccounts(transactionForm.elements.toAccount.value),
  );
  transactionForm.elements.category.addEventListener('change', () => {
    manualCategoryChosen = true;
    clearTimeout(classificationTimer);
    classificationRequest += 1;
    setSubcategoryOptions(transactionForm.elements.type.value);
  });
  transactionForm.elements.subcategory.addEventListener('change', () => { manualCategoryChosen = true; classificationRequest += 1; });
  transactionForm.elements.name.addEventListener('input', scheduleTransactionClassification);
  transactionForm.elements.note.addEventListener('input', scheduleTransactionClassification);
  document.querySelector('#voice-submit-button').addEventListener('click', () =>
    submitSpokenEntry(document.querySelector('#voice-transcript').value),
  );
  document.querySelector('#voice-review').addEventListener('click', event => {
    if (event.target.closest('#voice-review-cancel')) {
      spokenReviewDrafts = null;
      document.querySelector('#voice-review').hidden = true;
      return;
    }
    if (!event.target.closest('#voice-review-confirm') || !spokenReviewDrafts) return;
    const container = document.querySelector('#voice-review');
    const drafts = spokenReviewDrafts.map((draft, index) => ({
      ...draft,
      name: container.querySelector(`[data-review-name="${index}"]`).value.trim(),
      amount: Number(container.querySelector(`[data-review-amount="${index}"]`).value),
      account: container.querySelector(`[data-review-account="${index}"]`).value,
    }));
    if (drafts.some(draft => !draft.name || !Number.isSafeInteger(draft.amount) || draft.amount <= 0)) {
      showToast('請填妥每筆品項與正整數金額。', 'error');
      return;
    }
    void submitSpokenEntry(document.querySelector('#voice-transcript').value, drafts);
  });
  document.querySelector('#voice-transcript').addEventListener('input', () => {
    spokenReviewDrafts = null;
    document.querySelector('#voice-review').hidden = true;
  });
  document.querySelector('#voice-transcript').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSpokenEntry(event.currentTarget.value);
    }
  });
  main.addEventListener('click', handleMainClick);
  main.addEventListener('input', handleHistoryFilters);
  main.addEventListener('change', handleHistoryFilters);
  main.addEventListener('change', event => {
    const id = event.target.dataset.selectTransaction;
    if (!id) return;
    historySelection.ids = event.target.checked ? [...new Set([...historySelection.ids, id])] : historySelection.ids.filter(item => item !== id);
    render();
    requestAnimationFrame(() => main.querySelector(`[data-select-transaction="${CSS.escape(id)}"]`)?.focus());
  });
  main.addEventListener('submit', saveBudget);
  window.addEventListener('hashchange', () => {
    view = safeViewFromHash();
    render();
    syncOnViewChange();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (hasPendingSheetChanges(readPendingSheetChanges())) {
        void syncPendingSheetChanges();
      } else if (Date.now() - lastSheetPullAt >= RESUME_PULL_THRESHOLD_MS) {
        refreshSheetInBackground();
      }
    }
  });
  window.addEventListener('online', () => {
    pendingSheetRetryCount = 0;
    backgroundPullRetryCount = 0;
    clearTimeout(backgroundPullRetryTimer);
    backgroundPullRetryTimer = null;
    syncOnViewChange();
  });

  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    state = repository.load();
    applyTheme();
    render();
  });


  hydrateIcons();
  document.querySelector('#tools-button').innerHTML = icon('settings', 19);
  lastSheetPullAt = storedLastSyncAt();
  migrateLegacyBudgetChanges();
  discardLegacyInvestmentAccountUpload();
  applyDueRecurringTransactions();
  captureCompletedMonthSnapshot();
  setSyncStatus(lastSheetPullAt ? 'synced' : 'local', { lastAt: lastSheetPullAt });
  applyTheme();
  render();
  if (incomingDeviceBinding) showToast('手機已完成 Google Sheet 裝置綁定。');
  setTimeout(syncOnViewChange, 700);
  setInterval(() => syncOnViewChange(), BACKGROUND_PULL_INTERVAL_MS);
}
