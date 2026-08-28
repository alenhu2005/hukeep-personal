import { validateClassification } from '../domain/category-taxonomy.js';

const REQUEST_TIMEOUT_MS = 30_000;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeAiItems(items) {
  const sensitiveLine = /(?:發票(?:號碼|號)|invoice\s*(?:no|number)|載具|carrier|^[A-Z]{2}[\s-]?\d{4}[\s-]?\d{4}$|^\/[0-9A-Z+.-]{7}$)/i;
  const metadataLine = /^(?:date|日期|total|subtotal|tax|總計|合計|小計|稅額|付款金額|交易金額)/i;
  return Array.isArray(items)
    ? items
        .slice(0, 80)
        .map(item => cleanText(item, 160))
        .filter(item => item && !sensitiveLine.test(item) && !metadataLine.test(item))
    : [];
}

export function validateProxyEndpoint(value) {
  let url;
  try {
    url = new URL(cleanText(value, 500));
  } catch {
    throw new Error('代理網址格式不正確');
  }
  const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localDevelopment)) {
    throw new Error('代理網址必須使用 HTTPS');
  }
  return url.toString();
}

async function postProxy(endpoint, payload, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(validateProxyEndpoint(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new Error(`代理服務暫時無法使用（${response.status}）`);
  const envelope = await response.json();
  if (!envelope?.ok) throw new Error(cleanText(envelope?.error, 200) || '代理服務處理失敗');
  return envelope.data;
}

export async function classifyExpenseWithAi(input, options = {}) {
  const fallback = input?.fallback;
  const type = input?.type === 'income' ? 'income' : 'expense';
  const data = await postProxy(
    input?.endpoint,
    {
      action: type === 'income' ? 'classifyIncome' : 'classifyExpense',
      proxyToken: cleanText(input?.proxyToken, 300),
      merchant: cleanText(input?.merchant, 120),
      items: sanitizeAiItems(input?.items),
    },
    options,
  );
  if (Number(data?.confidence) <= 0 && fallback) {
    return validateClassification(fallback, { fallback, type });
  }
  return validateClassification(data, { fallback, type });
}

export async function syncCarrierInvoices(input, options = {}) {
  const month = cleanText(input?.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('同步月份格式不正確');
  const data = await postProxy(
    input?.endpoint,
    {
      action: 'syncCarrierInvoices',
      proxyToken: cleanText(input?.proxyToken, 300),
      cardNo: cleanText(input?.cardNo, 40),
      cardEncrypt: cleanText(input?.cardEncrypt, 100),
      month,
    },
    options,
  );
  if (!Array.isArray(data?.invoices)) throw new Error('代理回傳的發票格式不正確');
  return data.invoices.slice(0, 1000);
}
