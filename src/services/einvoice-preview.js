import { relayEInvoicePreview } from './import-proxy.js';
import { EInvoiceV2Client } from './tw-einvoice-v2.ts';

const PREVIEW_ROUTES = {
  'https://uia.einvoice.nat.gov.tw/mid/v1/login': 'login',
  'https://upi.einvoice.nat.gov.tw/einvoice/carriers/query-invoices-header': 'list',
  'https://upi.einvoice.nat.gov.tw/einvoice/carriers/query-invoices-details': 'detail',
};

function taipeiParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function periodAt(index, now) {
  const year = Math.floor(index / 6);
  const month = (index % 6) * 2 + 1;
  const end = new Date(Date.UTC(year, month + 1, 0));
  const current = taipeiParts(now);
  const currentDay = `${current.year}/${current.month}/${current.day}`;
  const endParts = taipeiParts(end);
  const periodEnd = `${endParts.year}/${endParts.month}/${endParts.day}`;
  return {
    label: `${year} 年 ${month}–${month + 1} 月`,
    start: `${year}/${String(month).padStart(2, '0')}/01`,
    end: periodEnd > currentDay ? currentDay : periodEnd,
  };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function findArray(value, keys, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findArray(child, keys, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function invoiceDate(value) {
  const raw = record(value);
  const epoch = Number(raw.time);
  if (epoch > 0 && Number.isFinite(epoch)) {
    const parts = taipeiParts(new Date(epoch));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const match = String(value || '').match(/(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})/);
  const year = match ? Number(match[1]) : Number(raw.year);
  const month = match ? Number(match[2]) : Number(raw.month);
  const day = match ? Number(match[3]) : Number(raw.date);
  if (!year || !month || !day) return '';
  const gregorian = year < 1911 ? year + 1911 : year;
  return `${gregorian}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function invoiceHeaders(payload) {
  const rows = findArray(payload, [
    'invoices', 'invoice', 'invoiceList', 'invList', 'headers', 'header',
    'invoiceHeaders', 'result', 'data', 'list',
  ]);
  return rows.map(row => {
    const item = record(row);
    const date = invoiceDate(item.invDate ?? item.invoiceDate ?? item.date);
    const number = firstText(item.invNum, item.invoiceNumber);
    const amount = Number(String(item.amount ?? item.total ?? item.totalAmount ?? '').replaceAll(',', ''));
    return {
      id: `${number || 'unknown'}:${date || 'unknown'}`,
      number,
      date,
      detailDate: date.replaceAll('-', '/'),
      merchant: firstText(item.sellerName, item.seller, item.sellerNameE) || '未知店家',
      amount: Number.isFinite(amount) && amount >= 0 ? Math.trunc(amount) : 0,
    };
  });
}

export function invoiceItems(payload) {
  const rows = findArray(payload, ['details', 'items', 'itemList', 'invoiceDetails', 'result', 'data', 'list']);
  return rows.map(row => {
    const item = record(row);
    return {
      name: firstText(item.description, item.itemName, item.name) || '未命名品項',
      quantity: firstText(item.quantity, item.qty),
      unitPrice: firstText(item.unitPrice, item.price),
      amount: firstText(item.amount, item.subtotal),
    };
  });
}

function previewFetch(input, init, connection, relayImpl) {
  const stage = PREVIEW_ROUTES[String(input)];
  if (!stage) throw new Error('發票預覽端點不正確');
  const raw = String(init.body ?? '');
  let payload;
  if (stage === 'login') {
    payload = JSON.parse(raw).ldata;
  } else {
    payload = new URLSearchParams(raw).get('einvoiceJwt');
  }
  return relayImpl({ ...connection, stage, payload }, { signal: init.signal })
    .then(({ status, body }) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
}

export async function previewEInvoices(connection, credentials, options = {}) {
  const mobile = String(credentials?.mobile ?? '').trim();
  const password = String(credentials?.password ?? '');
  if (!/^09\d{8}$/.test(mobile) || !password || password.length > 128) {
    throw new Error('請輸入電子發票 App 的手機號碼與密碼');
  }
  const relayImpl = options.relayImpl ?? relayEInvoicePreview;
  const client = new EInvoiceV2Client({
    signal: options.signal,
    fetchImpl: (input, init) => previewFetch(input, init, connection, relayImpl),
  });
  let session;
  try {
    session = await client.login({ mobile, password });
  } catch (error) {
    error.stage = 'login';
    throw error;
  }
  if (!session.carrierCode) throw new Error('登入成功，但未取得手機條碼');
  const now = options.now ?? new Date();
  const today = taipeiParts(now);
  const currentIndex = Number(today.year) * 6 + Math.floor((Number(today.month) - 1) / 2);
  const periods = [];
  for (let offset = 0; offset < 2; offset += 1) {
    const period = periodAt(currentIndex - offset, now);
    let payload;
    try {
      payload = await client.queryCarrierInvoices(session, period.start, period.end);
    } catch (error) {
      error.stage = 'list';
      throw error;
    }
    periods.push({
      label: period.label,
      invoices: invoiceHeaders(payload).sort((a, b) => b.date.localeCompare(a.date)),
    });
  }
  return {
    periods,
    async loadItems(invoice) {
      if (!session) throw new Error('發票預覽已結束');
      if (!invoice?.number || !invoice?.detailDate) throw new Error('這張發票缺少號碼或日期，無法讀取品項');
      try {
        return invoiceItems(await client.queryCarrierInvoiceDetail(session, invoice.number, invoice.detailDate));
      } catch (error) {
        error.stage = 'detail';
        throw error;
      }
    },
    dispose() { session = null; },
  };
}
