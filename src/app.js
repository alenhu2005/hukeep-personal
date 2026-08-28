import { parseBackup, serializeBackup, transactionsToCsv } from './backup.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './config.js';
import { removeBudget, upsertBudget } from './domain/budgets.js';
import {
  classifyIncomeLocally,
  classifyLocally,
  getSubcategories,
} from './domain/category-taxonomy.js';
import { parseSpokenTransaction } from './domain/spoken-entry.js';
import {
  ValidationError,
  createTransaction,
  removeTransaction,
  updateTransaction,
} from './domain/transactions.js';
import { escapeHtml, monthLabel, todayInTaipei } from './format.js';
import { hydrateIcons, icon } from './icons.js';
import { createLedgerRepository } from './storage/ledger-repository.js';
import { createSmartImportController } from './smart-import-controller.js';
import { recognizeSpeechOnce } from './services/speech-recognition.js';
import { renderView } from './views.js';

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
  let state = repository.load();
  let view = safeViewFromHash();
  let selectedMonth = todayInTaipei().slice(0, 7);
  let historyFilters = { query: '', type: '', account: '' };
  let lastDeleted = null;
  let toastTimer = null;
  let smartImportController = null;
  let classificationReady = false;
  let classificationTimer = null;
  let classificationRequest = 0;

  const main = document.querySelector('#app-main');
  const transactionDialog = document.querySelector('#transaction-dialog');
  const toolsDialog = document.querySelector('#tools-dialog');
  const transactionForm = document.querySelector('#transaction-form');
  const toast = document.querySelector('#toast');

  function persist(nextState) {
    try {
      state = repository.save(nextState);
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
    document.querySelector('#classification-status').hidden = transfer || editing;
  }

  function setClassificationMessage(title, detail) {
    const status = document.querySelector('#classification-status');
    status.querySelector('strong').textContent = title;
    status.querySelector('small').textContent = detail;
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

  function setTransactionAccount(selected) {
    const fallback = state.accounts.some(account => account.id === 'cash')
      ? 'cash'
      : state.accounts[0]?.id;
    const resolved = state.accounts.some(account => account.id === selected) ? selected : fallback;
    transactionForm.elements.account.value = resolved;
    updateDestinationAccounts(transactionForm.elements.toAccount.value);
  }

  function openTransactionDialog(transaction = null) {
    transactionForm.reset();
    document.querySelector('#transaction-error').hidden = true;
    transactionForm.elements.id.value = transaction?.id || '';
    transactionForm.elements.amount.value = transaction?.amount || '';
    transactionForm.elements.date.value = transaction?.date || todayInTaipei();
    transactionForm.elements.note.value = transaction?.note || '';
    setAccountOptions(transactionForm.elements.account, transaction?.account || 'cash');
    setTransactionType(
      transaction?.type || 'expense',
      transaction?.category || '',
      transaction?.subcategory || '',
      { classificationReady: Boolean(transaction) },
    );
    setClassificationMessage(
      transaction ? '目前分類' : '背景智慧分類',
      transaction
        ? '你可以直接修改大分類或小分類。'
        : '新增時不顯示分類；儲存後若發現有誤，可到紀錄中編輯。',
    );
    if (transaction?.toAccount) updateDestinationAccounts(transaction.toAccount);
    document.querySelector('#transaction-dialog-title').textContent = transaction ? '編輯這筆' : '記一筆';
    document.querySelector('#voice-transcript').value = '';
    document.querySelector('#voice-status').textContent =
      '會先產生可編輯草稿，不會直接儲存。支援時優先使用裝置內辨識。';
    transactionDialog.showModal();
    requestAnimationFrame(() => transactionForm.elements.amount.focus());
  }

  async function classifyTransactionNote({ force = false } = {}) {
    const type = transactionForm.elements.type.value;
    if (type === 'transfer') return true;
    const note = transactionForm.elements.note.value.trim();
    if (!note && !force) {
      setClassificationMessage('背景智慧分類', '輸入用途後會自動判斷；分類不會在新增畫面展開。');
      return false;
    }
    const request = ++classificationRequest;
    setClassificationMessage('正在智慧分類…', '先由本機判斷，再於已授權時交給 AI 複判。');

    const local =
      type === 'income'
        ? classifyIncomeLocally(note)
        : classifyLocally({ merchant: note, items: [note] });
    const classificationText =
      parseSpokenTransaction(note, { today: todayInTaipei() }).classificationText || note;
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
    setClassificationMessage(
      classification.ai
        ? `AI 已完成${type === 'income' ? '收入' : ''}分類`
        : `已完成本機${type === 'income' ? '收入' : ''}預分類`,
      '儲存後若發現有誤，可到紀錄中編輯。',
    );
    return true;
  }

  function scheduleTransactionClassification() {
    if (transactionForm.elements.id.value) return;
    classificationReady = transactionForm.elements.type.value === 'transfer';
    clearTimeout(classificationTimer);
    classificationTimer = setTimeout(() => classifyTransactionNote(), 650);
  }

  async function applySpokenDraft(value, recognitionMode = '') {
    const transcript = String(value ?? '').trim();
    if (!transcript) {
      showToast('請先說一句或輸入口語內容。', 'error');
      return;
    }
    const status = document.querySelector('#voice-status');
    const draft = parseSpokenTransaction(transcript, { today: todayInTaipei() });
    setTransactionType(draft.type, draft.category || '', draft.subcategory || '', {
      classificationReady: true,
    });
    transactionForm.elements.amount.value = draft.amount || '';
    transactionForm.elements.date.value = draft.date;
    transactionForm.elements.note.value = draft.note;
    setTransactionAccount(draft.account);
    if (draft.type === 'transfer') updateDestinationAccounts(draft.toAccount);

    if (draft.type !== 'transfer' && smartImportController) {
      status.textContent = '已理解內容，正在確認細分類…';
      const classification = await smartImportController.classifyDraft({
        type: draft.type,
        text: draft.classificationText,
        fallback: {
          topCategory: draft.category,
          subcategory: draft.subcategory,
          confidence: draft.confidence,
        },
      });
      setTransactionType(draft.type, classification.topCategory, classification.subcategory, {
        classificationReady: true,
      });
      setTransactionAccount(draft.account);
      setClassificationMessage(
        classification.ai
          ? `AI 已完成${draft.type === 'income' ? '收入' : ''}分類`
          : `已完成本機${draft.type === 'income' ? '收入' : ''}預分類`,
        '儲存後若發現有誤，可到紀錄中編輯。',
      );
      status.textContent = `${recognitionMode ? `${recognitionMode} · ` : ''}${classification.ai ? 'AI' : '本機'}分類完成${draft.amount ? '，請確認金額後儲存。' : '；金額未辨識，請手動補上。'}`;
    } else {
      const label = draft.type === 'income' ? '收入' : '轉帳';
      if (draft.type === 'income') {
        setClassificationMessage(
          '已完成收入分類',
          '儲存後若發現有誤，可到紀錄中編輯。',
        );
      }
      status.textContent = `${recognitionMode ? `${recognitionMode} · ` : ''}已解析${label}${draft.amount ? '，請確認後儲存。' : '；金額未辨識，請手動補上。'}`;
    }
    if (!draft.amount) transactionForm.elements.amount.focus();
  }

  async function listenForSpokenEntry() {
    const button = document.querySelector('#voice-listen-button');
    const status = document.querySelector('#voice-status');
    button.disabled = true;
    button.textContent = '聆聽中…';
    status.textContent = '請說出日期、用途、金額與帳戶。';
    try {
      const result = await recognizeSpeechOnce();
      document.querySelector('#voice-transcript').value = result.transcript;
      await applySpokenDraft(result.transcript, result.local ? '裝置內辨識' : '瀏覽器語音服務');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = '開始說話';
    }
  }

  async function saveTransaction(event) {
    event.preventDefault();
    const errorElement = document.querySelector('#transaction-error');
    if (transactionForm.elements.type.value !== 'transfer' && !classificationReady) {
      await classifyTransactionNote({ force: true });
    }
    const values = Object.fromEntries(new FormData(transactionForm));
    const input = { ...values, amount: Number(values.amount) };
    try {
      const transactions = values.id
        ? updateTransaction(state.transactions, values.id, input)
        : [...state.transactions, createTransaction(input)];
      if (!persist({ ...state, transactions })) return;
      transactionDialog.close();
      render();
      showToast(values.id ? '已更新這筆記錄。' : '記下來了。');
    } catch (error) {
      errorElement.textContent = error instanceof ValidationError ? error.message : '儲存失敗，請再試一次。';
      errorElement.hidden = false;
    }
  }

  function deleteTransaction(id) {
    const transaction = state.transactions.find(item => item.id === id);
    if (!transaction) return;
    const index = state.transactions.findIndex(item => item.id === id);
    if (!persist({ ...state, transactions: removeTransaction(state.transactions, id) })) return;
    lastDeleted = { transaction, index };
    render();
    showToast('已刪除一筆記錄。', 'default', {
      label: '復原',
      handler: () => {
        if (!lastDeleted) return;
        const transactions = state.transactions.toSpliced(lastDeleted.index, 0, lastDeleted.transaction);
        if (!persist({ ...state, transactions })) return;
        lastDeleted = null;
        render();
        showToast('已復原。');
      },
    });
  }

  function handleMainClick(event) {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.goView) navigate(target.dataset.goView);
    if (target.dataset.monthShift) {
      selectedMonth = shiftMonth(selectedMonth, Number(target.dataset.monthShift));
      render();
    }
    if (target.dataset.editId) {
      openTransactionDialog(state.transactions.find(item => item.id === target.dataset.editId));
    }
    if (target.dataset.deleteId) deleteTransaction(target.dataset.deleteId);
    if (target.dataset.removeBudget) {
      if (!persist({ ...state, budgets: removeBudget(state.budgets, target.dataset.removeBudget) })) return;
      render();
      showToast('已移除預算。');
    }
  }

  function handleHistoryFilters(event) {
    if (!['history-search', 'history-type', 'history-account'].includes(event.target.id)) return;
    historyFilters = {
      query: document.querySelector('#history-search')?.value || '',
      type: document.querySelector('#history-type')?.value || '',
      account: document.querySelector('#history-account')?.value || '',
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

  document.querySelectorAll('[data-nav-view]').forEach(button =>
    button.addEventListener('click', () => navigate(button.dataset.navView)),
  );
  document.querySelector('#quick-add-button').addEventListener('click', () => openTransactionDialog());
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    if (!persist({ ...state, preferences: { ...state.preferences, theme } })) return;
    applyTheme();
  });
  document.querySelector('#tools-button').addEventListener('click', () => toolsDialog.showModal());
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
  document.querySelectorAll('.dialog-close').forEach(button =>
    button.addEventListener('click', () => button.closest('dialog').close()),
  );
  transactionForm.addEventListener('submit', saveTransaction);
  transactionForm.addEventListener('click', event => {
    const button = event.target.closest('[data-transaction-type]');
    if (button) {
      setTransactionType(button.dataset.transactionType);
      setClassificationMessage(
        '背景智慧分類',
        '新增時不顯示分類；儲存後若發現有誤，可到紀錄中編輯。',
      );
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
  transactionForm.elements.note.addEventListener('input', scheduleTransactionClassification);
  document.querySelector('#voice-listen-button').addEventListener('click', listenForSpokenEntry);
  document.querySelector('#voice-parse-button').addEventListener('click', () =>
    applySpokenDraft(document.querySelector('#voice-transcript').value),
  );
  document.querySelector('#voice-transcript').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applySpokenDraft(event.currentTarget.value);
    }
  });
  main.addEventListener('click', handleMainClick);
  main.addEventListener('input', handleHistoryFilters);
  main.addEventListener('change', handleHistoryFilters);
  main.addEventListener('submit', saveBudget);
  window.addEventListener('hashchange', () => {
    view = safeViewFromHash();
    render();
  });

  smartImportController = createSmartImportController({
    getState: () => state,
    persist,
    render,
    showToast,
    getSelectedMonth: () => selectedMonth,
  });

  hydrateIcons();
  document.querySelector('#tools-button').innerHTML = icon('settings', 19);
  applyTheme();
  render();
}
