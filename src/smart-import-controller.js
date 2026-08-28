import {
  EXPENSE_TAXONOMY,
  classifyLocally,
  getSubcategories,
  validateClassification,
} from './domain/category-taxonomy.js';
import {
  invoiceToTransaction,
  normalizeInvoiceNumber,
  parseReceiptText,
  reconcileImportedTransactions,
} from './domain/imports.js';
import {
  classifyExpenseWithAi,
  sanitizeAiItems,
  syncCarrierInvoices,
} from './services/import-proxy.js';
import { recognizeReceiptImage } from './services/receipt-ocr.js';
import { todayInTaipei } from './format.js';

const recentCarrierSyncs = new Map();
const CARRIER_RETRY_DELAY_MS = 2 * 60 * 1000;

function setOptions(select, values, selected = '') {
  const options = values.map(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    return option;
  });
  select.replaceChildren(...options);
}

function syncAccountButtons(select, accounts) {
  const group = select.form.querySelector(`[data-account-for="${select.id}"]`);
  if (!group) return;
  const buttons = accounts.map(account => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.accountValue = account.id;
    button.setAttribute('aria-pressed', String(account.id === select.value));
    const icon = document.createElement('span');
    icon.className = 'account-choice-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = account.icon;
    const name = document.createElement('span');
    name.textContent = account.name;
    button.append(icon, name);
    return button;
  });
  group.replaceChildren(...buttons);
}

function setAccountOptions(select, accounts, selected = 'cash') {
  const options = accounts.map(account => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.name;
    option.selected = account.id === selected;
    return option;
  });
  select.replaceChildren(...options);
  if (!accounts.some(account => account.id === selected)) select.value = accounts[0]?.id || '';
  syncAccountButtons(select, accounts);
}

function selectAccountFromButton(event, form, accounts) {
  const button = event.target.closest('[data-account-value]');
  if (!button) return;
  const select = form.elements.account;
  select.value = button.dataset.accountValue;
  syncAccountButtons(select, accounts);
}

function receiptItems(text) {
  return sanitizeAiItems(String(text ?? '').split(/\r?\n/));
}

function createSourceId(file) {
  return `ocr:${file.name}:${file.size}:${file.lastModified}`.slice(0, 160);
}

function ocrProgressLabel(message) {
  const percentage = Math.round(message.progress * 100);
  const labels = {
    'loading tesseract core': '載入 OCR 引擎',
    'initializing tesseract': '初始化 OCR',
    'loading language traineddata': '載入繁中辨識模型',
    'initializing api': '準備辨識',
    'recognizing text': '辨識文字',
  };
  return `${labels[message.status] || '處理圖片'}${percentage ? ` · ${percentage}%` : ''}`;
}

function validCarrierInvoice(invoice) {
  return (
    invoice &&
    Number.isInteger(Number(invoice.amount)) &&
    Number(invoice.amount) > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(invoice.date ?? ''))
  );
}

export function createSmartImportController(dependencies) {
  const { getState, persist, render, showToast, getSelectedMonth } = dependencies;
  const receiptImage = document.querySelector('#receipt-image');
  const ocrProgress = document.querySelector('#ocr-progress');
  const ocrForm = document.querySelector('#ocr-draft-form');
  const classificationHint = document.querySelector('#ocr-classification-hint');
  const carrierForm = document.querySelector('#carrier-form');
  const carrierProgress = document.querySelector('#carrier-progress');
  let activeFile = null;
  let activeOcrConfidence = 0;

  function configureForms() {
    const state = getState();
    setAccountOptions(ocrForm.elements.account, state.accounts);
    setAccountOptions(carrierForm.elements.account, state.accounts);
    carrierForm.elements.endpoint.value =
      state.preferences.carrierEndpoint || import.meta.env.VITE_INVOICE_PROXY_URL || '';
    carrierForm.elements.cardNo.value = state.preferences.carrierCardNo || '';
    carrierForm.elements.month.value = getSelectedMonth();
    setOptions(ocrForm.elements.category, Object.keys(EXPENSE_TAXONOMY), '其他');
    setOptions(ocrForm.elements.subcategory, getSubcategories('其他'), '其他支出');
  }

  function setClassification(classification) {
    setOptions(
      ocrForm.elements.category,
      Object.keys(EXPENSE_TAXONOMY),
      classification.topCategory,
    );
    setOptions(
      ocrForm.elements.subcategory,
      getSubcategories(classification.topCategory),
      classification.subcategory,
    );
  }

  async function classifyOcrWithAi({ quiet = false } = {}) {
    const endpoint = carrierForm.elements.endpoint.value;
    const proxyToken = carrierForm.elements.proxyToken.value;
    if (!endpoint || !proxyToken) {
      if (!quiet) showToast('請先填入私人代理網址與通行碼。', 'error');
      return;
    }
    const fallback = validateClassification({
      topCategory: ocrForm.elements.category.value,
      subcategory: ocrForm.elements.subcategory.value,
      confidence: 0.5,
    });
    classificationHint.textContent = 'AI 正在判斷細分類…';
    try {
      const classification = await classifyExpenseWithAi({
        endpoint,
        proxyToken,
        merchant: ocrForm.elements.merchant.value,
        items: receiptItems(ocrForm.elements.rawText.value),
        fallback,
      });
      setClassification(classification);
      classificationHint.textContent = `AI 分類 · ${classification.topCategory}／${classification.subcategory}`;
    } catch (error) {
      classificationHint.textContent = `保留本機分類 · ${fallback.topCategory}／${fallback.subcategory}`;
      if (!quiet) showToast(error.message, 'error');
    }
  }

  async function handleReceiptImage(file) {
    if (!file) return;
    activeFile = file;
    ocrForm.hidden = true;
    receiptImage.disabled = true;
    ocrProgress.textContent = '正在啟動裝置內 OCR…第一次使用會下載繁中模型。';
    try {
      const recognition = await recognizeReceiptImage(file, {
        onProgress(message) {
          ocrProgress.textContent = ocrProgressLabel(message);
        },
      });
      const parsed = parseReceiptText(recognition.text);
      const items = receiptItems(recognition.text);
      const classification = classifyLocally({ merchant: parsed.merchant, items });
      activeOcrConfidence = recognition.confidence;
      ocrForm.elements.merchant.value = parsed.merchant;
      ocrForm.elements.amount.value = parsed.amount || '';
      ocrForm.elements.date.value = parsed.date || todayInTaipei();
      ocrForm.elements.invoiceNumber.value = parsed.invoiceNumber || '';
      ocrForm.elements.rawText.value = recognition.text;
      setClassification(classification);
      classificationHint.textContent = `本機分類 · ${classification.topCategory}／${classification.subcategory}`;
      ocrProgress.textContent = parsed.amount
        ? '辨識完成，請確認金額與日期。'
        : '已讀到文字，但找不到總額；請手動補上。';
      ocrForm.hidden = false;
      if (carrierForm.elements.endpoint.value && carrierForm.elements.proxyToken.value) {
        await classifyOcrWithAi({ quiet: true });
      }
    } catch (error) {
      ocrProgress.textContent = error.message || 'OCR 失敗，請換一張清楚的截圖。';
    } finally {
      receiptImage.disabled = false;
    }
  }

  function saveOcrDraft(event) {
    event.preventDefault();
    if (!activeFile) return;
    const values = Object.fromEntries(new FormData(ocrForm));
    try {
      const transaction = invoiceToTransaction(
        {
          amount: Number(values.amount),
          date: values.date,
          invoiceNumber: normalizeInvoiceNumber(values.invoiceNumber),
          merchant: values.merchant,
          items: receiptItems(values.rawText),
        },
        {
          source: 'ocr',
          sourceId: createSourceId(activeFile),
          account: values.account,
          category: values.category,
          subcategory: values.subcategory,
          ocrConfidence: activeOcrConfidence,
        },
      );
      const state = getState();
      const result = reconcileImportedTransactions(state.transactions, [transaction]);
      if (result.transactions.length === state.transactions.length) {
        showToast('這張發票已經記過了，沒有重複新增。');
        return;
      }
      if (!persist({ ...state, transactions: result.transactions })) return;
      render();
      ocrForm.hidden = true;
      receiptImage.value = '';
      activeFile = null;
      showToast('截圖已辨識、分類並記帳。');
    } catch (error) {
      showToast(error.message || '無法儲存 OCR 記錄。', 'error');
    }
  }

  async function handleCarrierSync(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(carrierForm));
    const syncKey = `${values.cardNo}:${values.month}`;
    const waitMs = CARRIER_RETRY_DELAY_MS - (Date.now() - (recentCarrierSyncs.get(syncKey) || 0));
    if (waitMs > 0) {
      showToast(`相同月份請等待 ${Math.ceil(waitMs / 1000)} 秒再同步。`, 'error');
      return;
    }
    const button = document.querySelector('#carrier-sync-button');
    button.disabled = true;
    carrierProgress.textContent = '正在向財政部取得發票與品項…';
    recentCarrierSyncs.set(syncKey, Date.now());
    try {
      const invoices = await syncCarrierInvoices(values);
      const candidates = invoices.flatMap((invoice, index) => {
        if (!validCarrierInvoice(invoice)) return [];
        const local = classifyLocally({ merchant: invoice.merchant, items: invoice.items });
        const classification =
          Number(invoice.classification?.confidence) > 0
            ? validateClassification(invoice.classification, { fallback: local })
            : local;
        try {
          return [
            invoiceToTransaction(invoice, {
              source: 'carrier',
              sourceId: String(invoice.sourceId || invoice.invoiceNumber || `carrier-${values.month}-${index}`),
              account: values.account,
              category: classification.topCategory,
              subcategory: classification.subcategory,
            }),
          ];
        } catch {
          return [];
        }
      });
      const state = getState();
      const beforeTransactions = state.transactions.map(transaction => ({
        ...transaction,
        ...(transaction.invoiceItems ? { invoiceItems: [...transaction.invoiceItems] } : {}),
      }));
      const result = reconcileImportedTransactions(state.transactions, candidates);
      const added = Math.max(0, result.transactions.length - state.transactions.length);
      const merged = result.replaced.length;
      const skipped = invoices.length - added - merged;
      const preferences = {
        ...state.preferences,
        carrierEndpoint: values.endpoint,
        carrierCardNo: values.cardNo,
      };
      if (!persist({ ...state, preferences, transactions: result.transactions })) return;
      render();
      carrierProgress.textContent = `同步完成：新增 ${added}、合併 ${merged}、略過 ${Math.max(0, skipped)}。`;
      showToast(`載具完成：新增 ${added} 筆、合併 ${merged} 筆。`, 'default', {
        label: '復原',
        handler: () => {
          const current = getState();
          if (!persist({ ...current, transactions: beforeTransactions })) return;
          render();
          showToast('已復原這次載具同步。');
        },
      });
    } catch (error) {
      carrierProgress.textContent = error.message || '載具同步失敗。';
      showToast(carrierProgress.textContent, 'error');
    } finally {
      carrierForm.elements.cardEncrypt.value = '';
      button.disabled = false;
    }
  }

  configureForms();
  receiptImage.addEventListener('change', event => handleReceiptImage(event.target.files?.[0]));
  ocrForm.elements.category.addEventListener('change', () => {
    setOptions(
      ocrForm.elements.subcategory,
      getSubcategories(ocrForm.elements.category.value),
    );
  });
  ocrForm.addEventListener('click', event =>
    selectAccountFromButton(event, ocrForm, getState().accounts),
  );
  ocrForm.addEventListener('submit', saveOcrDraft);
  document.querySelector('#ocr-ai-classify').addEventListener('click', () => classifyOcrWithAi());
  carrierForm.addEventListener('submit', handleCarrierSync);
  carrierForm.addEventListener('click', event =>
    selectAccountFromButton(event, carrierForm, getState().accounts),
  );
  document.querySelector('#smart-import-dialog').addEventListener('close', () => {
    carrierForm.elements.cardEncrypt.value = '';
  });

  async function classifyDraft(input) {
    const endpoint =
      carrierForm.elements.endpoint.value ||
      getState().preferences.carrierEndpoint ||
      import.meta.env.VITE_INVOICE_PROXY_URL;
    const proxyToken = carrierForm.elements.proxyToken.value;
    if (!endpoint || !proxyToken) return { ...input.fallback, ai: false };
    try {
      const classification = await classifyExpenseWithAi({
        type: input.type,
        endpoint,
        proxyToken,
        merchant: input.text,
        items: [input.text],
        fallback: input.fallback,
      });
      return { ...classification, ai: true };
    } catch {
      return { ...input.fallback, ai: false };
    }
  }

  return { classifyDraft, configureForms };
}
