import { classifyIncomeLocally, classifyLocally } from './category-taxonomy.js';

const CHINESE_DIGITS = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '兩': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
};

const SMALL_UNITS = { '十': 10, '百': 100, '千': 1000 };

function parseChineseNumber(value) {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const character of value) {
    if (character in CHINESE_DIGITS) {
      digit = CHINESE_DIGITS[character];
    } else if (character in SMALL_UNITS) {
      section += (digit || 1) * SMALL_UNITS[character];
      digit = 0;
    } else if (character === '萬') {
      total += (section + digit || 1) * 10_000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

function parseAmount(text) {
  const arabic = text.match(/(\d[\d,]*)\s*(?:元|塊(?:錢)?)/);
  if (arabic) return Number(arabic[1].replaceAll(',', ''));
  const chinese = text.match(/([零〇一二兩三四五六七八九十百千萬]+)\s*(?:元|塊(?:錢)?)/);
  if (chinese) return parseChineseNumber(chinese[1]);
  return null;
}

function shiftDate(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function isValidDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDate(text, today) {
  const [currentYear] = today.split('-').map(Number);
  const full = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?/);
  const short = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]/);
  if (full && isValidDate(Number(full[1]), Number(full[2]), Number(full[3]))) {
    return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  }
  if (short && isValidDate(currentYear, Number(short[1]), Number(short[2]))) {
    return `${currentYear}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
  }
  if (text.includes('前天')) return shiftDate(today, -2);
  if (text.includes('昨天') || text.includes('昨日')) return shiftDate(today, -1);
  return today;
}

function accountFromText(text, fallback = 'cash') {
  if (/line\s*(?:bank|pay)?/i.test(text)) return 'line';
  if (/(?:永豐|sinopac)/i.test(text)) return 'sinopac';
  if (/(?:台銀|臺銀|台灣銀行|臺灣銀行)/.test(text)) return 'bot';
  if (/(?:郵局|中華郵政)/.test(text)) return 'post';
  if (/(?:現金|付現|錢包)/.test(text)) return 'cash';
  if (/(?:信用卡|刷卡|卡片)/.test(text)) return 'sinopac';
  return fallback;
}

function transactionType(text) {
  if (/從.+(?:轉|匯).+(?:到|進)/.test(text)) return 'transfer';
  if (/(?:薪水|薪資|獎金|收入|入帳|退款|退費|股息|股利|利息|接案|稿費|收到|零用錢|家教|中獎|紅包|禮金|補助|理賠|賣二手)/.test(text)) {
    return 'income';
  }
  return 'expense';
}

function classificationText(text) {
  return text
    .replace(/(?:今天|昨日|昨天|前天|剛剛)/g, ' ')
    .replace(/(?:20\d{2}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日號]?/g, ' ')
    .replace(/\d[\d,]*\s*(?:元|塊(?:錢)?)/g, ' ')
    .replace(/[零〇一二兩三四五六七八九十百千萬]+\s*(?:元|塊(?:錢)?)/g, ' ')
    .replace(/(?:line\s*(?:bank|pay)?|永豐|sinopac|台銀|臺銀|台灣銀行|臺灣銀行|郵局|中華郵政|刷卡|信用卡|卡片|銀行|帳戶|現金|付現|錢包|入帳)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSpokenTransaction(value, options = {}) {
  const transcript = String(value ?? '').normalize('NFKC').trim().slice(0, 240);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const type = transactionType(transcript);
  const amount = parseAmount(transcript);
  const date = parseDate(transcript, today);
  const hasDateCue = /(?:今天|昨日|昨天|前天|\d{1,2}\s*月\s*\d{1,2}\s*[日號])/.test(transcript);
  const hasAccountCue = /(?:line|永豐|sinopac|台銀|臺銀|台灣銀行|臺灣銀行|郵局|中華郵政|信用卡|刷卡|卡片|銀行|帳戶|存款|現金|付現|錢包)/i.test(transcript);

  if (type === 'transfer') {
    const sourceText = transcript.split(/(?:轉|匯)/)[0];
    const destinationText = transcript.split(/(?:到|進)/).at(-1);
    return {
      transcript,
      type,
      amount,
      date,
      account: accountFromText(sourceText, 'sinopac'),
      toAccount: accountFromText(destinationText, 'cash'),
      category: null,
      subcategory: null,
      note: transcript,
      classificationText: classificationText(transcript),
      confidence: amount ? 0.9 : 0.35,
    };
  }

  const classification =
    type === 'income'
      ? classifyIncomeLocally(transcript)
      : classifyLocally({ merchant: transcript, items: [transcript] });
  const confidence =
    (amount ? 0.45 : 0) +
    classification.confidence * 0.35 +
    (hasDateCue ? 0.1 : 0) +
    (hasAccountCue ? 0.1 : 0);

  return {
    transcript,
    type,
    amount,
    date,
    account: accountFromText(transcript),
    toAccount: null,
    category: classification.topCategory,
    subcategory: classification.subcategory,
    note: transcript,
    classificationText: classificationText(transcript),
    confidence: Math.min(1, confidence),
  };
}
