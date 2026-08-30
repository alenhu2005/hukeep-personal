import QRCode from 'qrcode';

import { parseBackup, serializeBackup, transactionsToCsv } from './backup.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './config.js';
import { updateOpeningBalances } from './domain/accounts.js';
import { removeBudget, upsertBudget } from './domain/budgets.js';
import {
  classifyIncomeLocally,
  classifyLocally,
  getSubcategories,
} from './domain/category-taxonomy.js';
import { parseSpokenTransactions } from './domain/spoken-entry.js';
import {
  hasPendingSheetChanges,
  reconcileLedgerFromSheet,
  updatePendingSheetChanges,
} from './domain/ledger-sync.js';
import {
  ValidationError,
  createTransaction,
  normalizeStoredTransaction,
  removeTransaction,
  updateTransaction,
} from './domain/transactions.js';
import { escapeHtml, formatMoney, monthLabel, todayInTaipei } from './format.js';
import { hydrateIcons, icon } from './icons.js';
import { createLedgerRepository } from './storage/ledger-repository.js';
import { createSmartImportController } from './smart-import-controller.js';
import {
  claimDevicePairingCode,
  createDevicePairingCode,
  deleteLedgerBudgetFromSheet,
  deleteLedgerTransactionFromSheet,
  enqueueSpokenEntry,
  loadLedgerStateFromSheet,
  syncLedgerChangesToSheet,
  syncLedgerStateToSheet,
} from './services/import-proxy.js';
import {
  createDeviceBindingPayload,
  createDeviceBindingStore,
  parseDeviceBindingHash,
} from './services/device-binding.js';
import { renderView } from './views.js';

const LAST_SHEET_SYNC_KEY = 'hukeep_last_sheet_sync_at';
const PENDING_SHEET_CHANGES_KEY = 'hukeep_pending_sheet_changes_v1';
const BUDGET_SYNC_MIGRATION_KEY = 'hukeep_budget_sync_migrated_v2';
const AUTO_SYNC_DEBOUNCE_MS = 800;
const BACKGROUND_PULL_INTERVAL_MS = 2 * 60 * 1000;
const RESUME_PULL_THRESHOLD_MS = 15 * 1000;

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
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
  let historyFilters = { query: '', type: '', account: '' };
  let toastTimer = null;
  let smartImportController = null;
  let classificationReady = false;
  let classificationTimer = null;
  let classificationRequest = 0;
  let sheetPullInFlight = false;
  let sheetWriteInFlight = false;
  let lastSheetPullAt = 0;
  let pendingSheetSyncTimer = null;
  let deviceBindingLink = '';

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
        accountUpserts: Array.isArray(value?.accountUpserts) ? value.accountUpserts : [],
        accountDeletes: Array.isArray(value?.accountDeletes) ? value.accountDeletes : [],
        budgetUpserts: Array.isArray(value?.budgetUpserts) ? value.budgetUpserts : [],
        budgetDeletes: Array.isArray(value?.budgetDeletes) ? value.budgetDeletes : [],
      };
    } catch {
      return {
        upserts: [],
        deletes: [],
        accountUpserts: [],
        accountDeletes: [],
        budgetUpserts: [],
        budgetDeletes: [],
      };
    }
  }

  function writePendingSheetChanges(value) {
    try {
      localStorage.setItem(PENDING_SHEET_CHANGES_KEY, JSON.stringify(value));
    } catch {
      // Ledger storage errors are handled by persist; this journal is best effort.
    }
  }

  function clearPendingSheetChanges() {
    try {
      localStorage.removeItem(PENDING_SHEET_CHANGES_KEY);
    } catch {
      // A stale journal is safer than discarding unsynced local changes.
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

  function acknowledgePendingTransactionDelete(transactionId) {
    const pending = readPendingSheetChanges();
    writePendingSheetChanges({
      ...pending,
      upserts: pending.upserts.filter(id => id !== transactionId),
      deletes: pending.deletes.filter(id => id !== transactionId),
    });
  }

  function setSyncStatus(status, options = {}) {
    const indicator = document.querySelector('#sync-indicator');
    const labels = {
      local: '僅本機',
      syncing: '同步中',
      pending: 'AI 待審',
      synced: '已同步',
      error: '同步失敗',
    };
    const lastAt = options.lastAt || storedLastSyncAt();
    const timeLabel = lastAt
      ? new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit' }).format(lastAt)
      : '';
    const label = labels[status] || labels.local;
    indicator.dataset.status = status;
    indicator.querySelector('strong').textContent = label;
    indicator.setAttribute(
      'aria-label',
      options.detail || `${label}${timeLabel ? `，最後更新 ${timeLabel}` : ''}`,
    );
    indicator.title = indicator.getAttribute('aria-label');
  }

  function rememberSuccessfulSync() {
    const now = Date.now();
    lastSheetPullAt = now;
    try {
      localStorage.setItem(LAST_SHEET_SYNC_KEY, String(now));
    } catch {
      // The visual state still updates when timestamp persistence is unavailable.
    }
    setSyncStatus('synced', { lastAt: now });
  }

  function persist(nextState, options = {}) {
    try {
      const previousState = state;
      const savedState = repository.save(nextState);
      if (!options.sheetSourced) {
        const previousPending = readPendingSheetChanges();
        const nextPending = updatePendingSheetChanges(previousPending, previousState, savedState);
        writePendingSheetChanges(nextPending);
        if (JSON.stringify(previousPending) !== JSON.stringify(nextPending) && hasPendingSheetChanges(nextPending)) {
          schedulePendingSheetSync();
        }
      }
      state = savedState;
      return true;
    } catch (error) {
      showToast('無法儲存，請先匯出備份並檢查瀏覽器空間。', 'error');
      console.error(error);
      return false;
    }
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
    main.innerHTML = renderView(view, state, selectedMonth, historyFilters);
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
    const subcategories = getSubcategories(category, type);
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
    document.querySelector('#category-field').hidden = transfer || !editing;
    document.querySelector('#subcategory-field').hidden = transfer || !editing;
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
    const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    transactionForm.elements.category.innerHTML = categories
      .map(
        category =>
          `<option value="${escapeHtml(category)}" ${category === selectedCategory ? 'selected' : ''}>${escapeHtml(category)}</option>`,
      )
      .join('');
    if (!transfer) setSubcategoryOptions(type, selectedSubcategory);
    setClassificationVisibility(type, Boolean(options.classificationReady));
    updateDestinationAccounts();
  }

  function updateDestinationAccounts(selected = '') {
    const account = transactionForm.elements.account.value;
    setAccountOptions(transactionForm.elements.toAccount, selected, account);
    syncAccountButtons(transactionForm.elements.account);
  }

  function openTransactionDialog(transaction = null) {
    transactionForm.reset();
    document.querySelector('#manual-entry').open = Boolean(transaction);
    document.querySelector('#transaction-error').hidden = true;
    transactionForm.elements.id.value = transaction?.id || '';
    transactionForm.elements.name.value = transaction?.name || transaction?.note || '';
    transactionForm.elements.amount.value = transaction?.amount || '';
    transactionForm.elements.fee.value = transaction?.fee || '';
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
    document.querySelector('#voice-status').textContent =
      '用鍵盤麥克風輸入後直接送出；Sheet 會先收到，AI 再從後台審查。';
    transactionDialog.showModal();
    requestAnimationFrame(() =>
      (transaction ? transactionForm.elements.name : document.querySelector('#voice-transcript')).focus(),
    );
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
    const classification = smartImportController
      ? await smartImportController.classifyDraft({
          type,
          text: classificationText,
          fallback: local,
        })
      : { ...local, ai: false };
    if (request !== classificationRequest) return false;
    setTransactionType(type, classification.topCategory, classification.subcategory, {
      classificationReady: true,
    });
    return true;
  }

  function scheduleTransactionClassification() {
    if (transactionForm.elements.id.value) return;
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
    setTransactionType(type, classification.topCategory, classification.subcategory, {
      classificationReady: true,
    });
  }

  async function submitSpokenEntry(value) {
    const transcript = String(value ?? '').trim();
    if (!transcript) {
      showToast('請先說一句或輸入口語內容。', 'error');
      return;
    }
    const status = document.querySelector('#voice-status');
    const button = document.querySelector('#voice-submit-button');
    const credentials = proxySession();
    if (!credentials.endpoint || !credentials.proxyToken) {
      status.textContent = '這台裝置尚未綁定 Google Sheet，請先完成裝置授權。';
      showToast('這台裝置尚未綁定 Sheet。', 'error');
      return;
    }
    const drafts = parseSpokenTransactions(transcript, { today: todayInTaipei() });
    button.disabled = true;
    setSyncStatus('syncing');
    status.textContent = '正在上傳 Sheet…不需等待 AI 審查。';
    try {
      const firstResult = await enqueueSpokenEntry({
        ...credentials,
        transcript,
        draft: drafts[0],
        drafts,
      });
      // Older deployed GAS versions only consume the legacy `draft` field and
      // therefore return one transaction even when the web app has detected
      // several items. Send the remaining drafts individually in that case,
      // using a self-contained transcript so legacy AI review cannot merge
      // them back into one record.
      const handledDrafts = Math.max(1, Math.min(firstResult.transactions.length, drafts.length));
      const remainingDrafts = drafts.slice(handledDrafts);
      const additionalResults = await remainingDrafts.reduce(
        async (resultsPromise, draft) => {
          const results = await resultsPromise;
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
          });
          return [...results, result];
        },
        Promise.resolve([]),
      );
      const uploaded = [firstResult, ...additionalResults]
        .flatMap(result => result.transactions)
        .map(normalizeStoredTransaction)
        .filter(Boolean);
      if (uploaded.length) {
        const uploadedById = new Map(uploaded.map(transaction => [transaction.id, transaction]));
        const transactions = [
          ...state.transactions.map(item => uploadedById.get(item.id) || item),
          ...uploaded.filter(transaction => !state.transactions.some(item => item.id === transaction.id)),
        ];
        if (!persist({ ...state, transactions }, { sheetSourced: true })) return;
      }
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      document.querySelector('#voice-transcript').value = '';
      transactionDialog.close();
      render();
      setSyncStatus('pending', { detail: '已上傳 Sheet，AI 後台待審' });
      showToast(
        uploaded.length > 1
          ? `已上傳 ${uploaded.length} 筆到 Sheet，AI 會在後台審查更新。`
          : '已上傳 Sheet，AI 會在後台審查更新。',
      );
    } catch (error) {
      status.textContent = error.message;
      setSyncStatus('error', { detail: `Sheet 上傳失敗：${error.message}` });
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
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
      const transactions = values.id
        ? updateTransaction(state.transactions, values.id, input)
        : [...state.transactions, createTransaction(input)];
      if (!persist({ ...state, transactions })) return;
      setSyncStatus('local', { detail: '已儲存在本機，尚未同步這次修改' });
      transactionDialog.close();
      render();
      showToast(values.id ? '已更新這筆記錄。' : '記下來了。');
    } catch (error) {
      errorElement.textContent = error instanceof ValidationError ? error.message : '儲存失敗，請再試一次。';
      errorElement.hidden = false;
    }
  }

  async function deleteTransaction(id) {
    const transaction = state.transactions.find(item => item.id === id);
    if (!transaction) return;
    const name = transaction.name || transaction.note || '這筆記錄';
    if (!confirm(`確定要刪除「${name}」嗎？這會一併刪除 Google Sheet 中的同一筆資料。`)) return;
    const credentials = proxySession();
    if (!credentials.bound) {
      showToast('這台裝置尚未綁定 Google Sheet，無法確認同步刪除。', 'error');
      return;
    }
    setSyncStatus('syncing');
    try {
      await deleteLedgerTransactionFromSheet({ ...credentials, transactionId: id });
    } catch (error) {
      setSyncStatus('error', { detail: `Sheet 刪除失敗：${error.message}` });
      showToast(`尚未刪除：${error.message}`, 'error');
      return;
    }
    if (!persist({ ...state, transactions: removeTransaction(state.transactions, id) })) return;
    acknowledgePendingTransactionDelete(id);
    rememberProxySession(credentials.endpoint, credentials.proxyToken);
    rememberSuccessfulSync();
    render();
    showToast('已從本機與 Google Sheet 刪除。');
  }

  async function deleteBudget(category) {
    if (!confirm(`確定要移除「${category}」預算嗎？這會一併刪除 Google Sheet 中的預算資料。`)) return;
    const credentials = proxySession();
    if (!credentials.bound) {
      showToast('這台裝置尚未綁定 Google Sheet，無法確認同步刪除。', 'error');
      return;
    }
    setSyncStatus('syncing');
    try {
      await deleteLedgerBudgetFromSheet({ ...credentials, category });
    } catch (error) {
      setSyncStatus('error', { detail: `Sheet 刪除失敗：${error.message}` });
      showToast(`尚未移除預算：${error.message}`, 'error');
      return;
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
    const category = isTransfer
      ? '轉帳'
      : [transaction.category, transaction.subcategory].filter(Boolean).join(' · ') || '未分類';
    const account = isTransfer
      ? `${accounts[transaction.account] || transaction.account} → ${accounts[transaction.toAccount] || transaction.toAccount}`
      : accounts[transaction.account] || transaction.account;
    const amount = `${transaction.type === 'expense' ? '-' : transaction.type === 'income' ? '+' : ''}${formatMoney(transaction.amount)}`;
    const detailDialog = document.querySelector('#transaction-detail-dialog');
    detailDialog.querySelector('#transaction-detail-title').textContent = transaction.name || '交易詳情';
    detailDialog.querySelector('#transaction-detail-content').innerHTML = `
      <dl class="transaction-detail-list">
        <div><dt>類型</dt><dd>${escapeHtml(transaction.type === 'expense' ? '支出' : transaction.type === 'income' ? '收入' : '轉帳')}</dd></div>
        <div><dt>金額</dt><dd class="${escapeHtml(transaction.type)}">${escapeHtml(amount)}</dd></div>
        <div><dt>分類</dt><dd>${escapeHtml(category)}</dd></div>
        <div><dt>帳戶</dt><dd>${escapeHtml(account)}</dd></div>
        <div><dt>備註</dt><dd>${escapeHtml(transaction.note || '—')}</dd></div>
        <div><dt>建立時間</dt><dd>${escapeHtml(formatDetailTimestamp(transaction.createdAt))}</dd></div>
        <div><dt>最後更新</dt><dd>${escapeHtml(formatDetailTimestamp(transaction.updatedAt))}</dd></div>
      </dl>`;
    detailDialog.showModal();
  }

  function handleMainClick(event) {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.historyFilter) {
      const key = target.dataset.historyFilter;
      const value = target.dataset.historyValue || '';
      historyFilters = { ...historyFilters, [key]: value };
      render();
      requestAnimationFrame(() =>
        main
          .querySelector(`[data-history-filter="${key}"][data-history-value="${value}"]`)
          ?.focus(),
      );
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
      account: historyFilters.account,
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
      downloadText(`hukeep-personal-${date}.csv`, transactionsToCsv(state.transactions), 'text/csv;charset=utf-8');
    }
    showToast('備份已開始下載。');
  }

  async function importData(file) {
    if (!file) return;
    try {
      const imported = parseBackup(await file.text());
      const okay = confirm(`要用這份備份取代目前的 ${state.transactions.length} 筆資料嗎？`);
      if (!okay) return;
      downloadText(`hukeep-personal-before-import-${todayInTaipei()}.json`, serializeBackup(state), 'application/json');
      if (!persist(imported)) return;
      toolsDialog.close();
      render();
      showToast(`已還原 ${imported.transactions.length} 筆記錄。`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function configureToolsForms() {
    const fields = document.querySelector('#opening-balance-fields');
    fields.innerHTML = state.accounts
      .map(
        account => `<label><span>${escapeHtml(account.name)}初始金額</span><input name="${escapeHtml(account.id)}" type="number" step="1" inputmode="numeric" value="${account.openingBalance}" required /></label>`,
      )
      .join('');
    updateDeviceBindingStatus();
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
    if (document.hidden || !hasPendingSheetChanges(readPendingSheetChanges())) return;
    pendingSheetSyncTimer = setTimeout(() => {
      pendingSheetSyncTimer = null;
      void syncPendingSheetChanges();
    }, delay);
  }

  async function syncPendingSheetChanges() {
    const changes = readPendingSheetChanges();
    const stateAtRequest = state;
    let completed = false;
    const credentials = proxySession();
    if (
      sheetWriteInFlight ||
      document.hidden ||
      !hasPendingSheetChanges(changes) ||
      !credentials.bound
    ) {
      return false;
    }
    sheetWriteInFlight = true;
    setSyncStatus('syncing');
    try {
      await syncLedgerChangesToSheet({ ...credentials, state, changes });
      if (state === stateAtRequest) clearPendingSheetChanges();
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      rememberSuccessfulSync();
      completed = true;
      return true;
    } catch (error) {
      setSyncStatus('error', { detail: `自動同步失敗：${error.message}` });
      return false;
    } finally {
      sheetWriteInFlight = false;
      if (completed && state !== stateAtRequest && hasPendingSheetChanges(readPendingSheetChanges())) {
        schedulePendingSheetSync();
      }
    }
  }

  function syncOnViewChange() {
    if (document.hidden) return;
    if (hasPendingSheetChanges(readPendingSheetChanges())) {
      void syncPendingSheetChanges();
      return;
    }
    void refreshSheetInBackground({ force: true });
  }

  async function syncSheet(event) {
    event.preventDefault();
    const button = document.querySelector('#sheet-sync-button');
    const status = document.querySelector('#sheet-sync-status');
    const credentials = proxySession();
    clearTimeout(pendingSheetSyncTimer);
    button.disabled = true;
    sheetWriteInFlight = true;
    setSyncStatus('syncing');
    status.classList.remove('error');
    status.textContent = '正在安全同步…';
    try {
      const result = await syncLedgerStateToSheet({
        ...credentials,
        state,
      });
      if (
        !persist({
          ...state,
          preferences: { ...state.preferences, proxyEndpoint: credentials.endpoint },
        })
      ) {
        return;
      }
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      clearPendingSheetChanges();
      rememberSuccessfulSync();
      status.textContent = `同步完成：${result.accountCount} 個帳戶、${result.transactionCount} 筆交易、${result.budgetCount} 筆預算。`;
      showToast('Google Sheet 同步完成。');
    } catch (error) {
      setSyncStatus('error', { detail: `Sheet 同步失敗：${error.message}` });
      status.classList.add('error');
      status.textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      sheetWriteInFlight = false;
      button.disabled = false;
    }
  }

  async function loadSheet() {
    const syncButton = document.querySelector('#sheet-sync-button');
    const loadButton = document.querySelector('#sheet-load-button');
    const status = document.querySelector('#sheet-sync-status');
    const credentials = proxySession();
    if (!confirm('要從 Sheet 取回最新資料嗎？Sheet 已刪除的紀錄也會從網頁移除；尚未上傳的本機修改會保留。')) return;
    syncButton.disabled = true;
    loadButton.disabled = true;
    setSyncStatus('syncing');
    status.classList.remove('error');
    status.textContent = '正在從 Sheet 讀取…';
    try {
      const sheetState = await loadLedgerStateFromSheet({
        ...credentials,
      });
      const merged = reconcileLedgerFromSheet(state, sheetState, readPendingSheetChanges());
      if (!persist({
        ...merged,
        preferences: { ...merged.preferences, proxyEndpoint: credentials.endpoint },
      }, { sheetSourced: true })) {
        return;
      }
      rememberProxySession(credentials.endpoint, credentials.proxyToken);
      rememberSuccessfulSync();
      render();
      status.textContent = `讀取完成：${sheetState.accounts.length} 個帳戶、${sheetState.transactions.length} 筆交易、${sheetState.budgets.length} 筆預算。`;
      showToast('Google Sheet 資料已更新到本機。');
    } catch (error) {
      setSyncStatus('error', { detail: `Sheet 讀取失敗：${error.message}` });
      status.classList.add('error');
      status.textContent = error.message;
      showToast(error.message, 'error');
    } finally {
      syncButton.disabled = false;
      loadButton.disabled = false;
    }
  }

  async function refreshSheetInBackground(options = {}) {
    const credentials = proxySession();
    const now = Date.now();
    if (
      sheetPullInFlight ||
      sheetWriteInFlight ||
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
      const remote = await loadLedgerStateFromSheet(credentials);
      const reconciled = reconcileLedgerFromSheet(state, remote, readPendingSheetChanges());
      if (!persist(reconciled, { sheetSourced: true })) return;
      rememberSuccessfulSync();
      render();
    } catch (error) {
      setSyncStatus('error', { detail: `背景 Sheet 更新失敗：${error.message}` });
    } finally {
      sheetPullInFlight = false;
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
  document.querySelector('#smart-import-button').addEventListener('click', () => {
    smartImportController?.configureForms();
    toolsDialog.close();
    document.querySelector('#smart-import-dialog').showModal();
  });
  document.querySelector('#export-json').addEventListener('click', () => exportData('json'));
  document.querySelector('#export-csv').addEventListener('click', () => exportData('csv'));
  document.querySelector('#import-json').addEventListener('change', event => {
    const input = event.target;
    importData(input.files?.[0]).finally(() => {
      input.value = '';
    });
  });
  document.querySelector('#opening-balance-form').addEventListener('submit', saveOpeningBalances);
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
  transactionForm.addEventListener('submit', saveTransaction);
  transactionForm.addEventListener('click', event => {
    const button = event.target.closest('[data-transaction-type]');
    if (button) {
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
  transactionForm.elements.category.addEventListener('change', () =>
    setSubcategoryOptions(transactionForm.elements.type.value),
  );
  transactionForm.elements.name.addEventListener('input', scheduleTransactionClassification);
  transactionForm.elements.note.addEventListener('input', scheduleTransactionClassification);
  document.querySelector('#voice-submit-button').addEventListener('click', () =>
    submitSpokenEntry(document.querySelector('#voice-transcript').value),
  );
  document.querySelector('#voice-transcript').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSpokenEntry(event.currentTarget.value);
    }
  });
  main.addEventListener('click', handleMainClick);
  main.addEventListener('input', handleHistoryFilters);
  main.addEventListener('change', handleHistoryFilters);
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
  window.addEventListener('online', () => syncOnViewChange());

  smartImportController = createSmartImportController({
    getState: () => state,
    persist,
    render,
    showToast,
    getSelectedMonth: () => selectedMonth,
    getProxyCredentials: proxySession,
    rememberProxyCredentials: rememberProxySession,
  });

  hydrateIcons();
  document.querySelector('#tools-button').innerHTML = icon('settings', 19);
  lastSheetPullAt = storedLastSyncAt();
  migrateLegacyBudgetChanges();
  setSyncStatus(lastSheetPullAt ? 'synced' : 'local', { lastAt: lastSheetPullAt });
  applyTheme();
  render();
  if (incomingDeviceBinding) showToast('手機已完成 Google Sheet 裝置綁定。');
  setTimeout(syncOnViewChange, 700);
  setInterval(() => syncOnViewChange(), BACKGROUND_PULL_INTERVAL_MS);
}
