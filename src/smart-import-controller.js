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
} from './services/import-proxy.js';
import { recognizeReceiptImage } from './services/receipt-ocr.js';
import { storeReceipt } from './storage/receipt-store.js';
import { todayInTaipei } from './format.js';

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

export function createSmartImportController(dependencies) {
  const {
    getState,
    persist,
    render,
    showToast,
    getProxyCredentials,
  } = dependencies;
  const receiptImage = document.querySelector('#receipt-image');
  const ocrProgress = document.querySelector('#ocr-progress');
  const ocrForm = document.querySelector('#ocr-draft-form');
  const classificationHint = document.querySelector('#ocr-classification-hint');
  let activeFile = null;
  let activeOcrConfidence = 0;

  function configureForms() {
    const state = getState();
    setAccountOptions(ocrForm.elements.account, state.accounts);
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
    const { endpoint, proxyToken } = getProxyCredentials();
    if (!endpoint || !proxyToken) {
      if (!quiet) showToast('這台裝置尚未綁定 Sheet。', 'error');
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
      if (getProxyCredentials().bound) {
        await classifyOcrWithAi({ quiet: true });
      }
    } catch (error) {
      ocrProgress.textContent = error.message || 'OCR 失敗，請換一張清楚的截圖。';
    } finally {
      receiptImage.disabled = false;
    }
  }

  async function saveOcrDraft(event) {
    event.preventDefault();
    if (!activeFile) return;
    const values = Object.fromEntries(new FormData(ocrForm));
    try {
      const receipt = await storeReceipt(activeFile);
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
          receiptId: receipt?.id,
          receiptName: receipt?.name,
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
  async function classifyDraft(input) {
    const { endpoint, proxyToken } = getProxyCredentials();
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
