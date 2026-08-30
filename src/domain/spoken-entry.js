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
const AMOUNT_TOKEN_PATTERN = '[\\d,\\s十百千萬零〇一二兩三四五六七八九]+';

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
  const standardValue = total + section + digit;
  const lastCharacter = value.at(-1);
  const lastUnitCharacter = [...value].toReversed().find(character =>
    Object.hasOwn(SMALL_UNITS, character) || character === '萬',
  );
  const lastUnit = lastUnitCharacter === '萬' ? 10_000 : SMALL_UNITS[lastUnitCharacter];
  if (
    lastCharacter in CHINESE_DIGITS &&
    lastUnit >= 100 &&
    !/[零〇]/.test(value)
  ) {
    const trailingDigit = CHINESE_DIGITS[lastCharacter];
    return standardValue - trailingDigit + trailingDigit * (lastUnit / 10);
  }
  return standardValue;
}

function parseArabicUnitNumber(value) {
  const normalized = value.replace(/[\s,]/g, '');
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const tokens = normalized.match(/\d+|[十百千萬]/g) || [];
  if (tokens.join('') !== normalized) return Number.NaN;
  let total = 0;
  let section = 0;
  let number = 0;
  let lastUnit = 1;
  tokens.forEach(token => {
    if (/^\d+$/.test(token)) {
      number = Number(token);
    } else if (token === '萬') {
      total += (section + number || 1) * 10_000;
      section = 0;
      number = 0;
      lastUnit = 10_000;
    } else {
      const unit = SMALL_UNITS[token];
      section += (number || 1) * unit;
      number = 0;
      lastUnit = unit;
    }
  });
  const trailingToken = tokens.at(-1);
  if (/^[1-9]$/.test(trailingToken) && lastUnit >= 100) {
    number *= lastUnit / 10;
  }
  return total + section + number;
}

function numberFromAmountToken(value) {
  const compact = value.replace(/\s/g, '');
  const amount = /\d/.test(compact)
    ? parseArabicUnitNumber(compact)
    : parseChineseNumber(compact);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function isNonAmountCandidate(text, match) {
  const raw = match[0].replace(/[\s,]/g, '');
  const next = text.slice(match.index + match[0].length).trimStart();
  if (/^[年月日號]/.test(next)) return true;
  if (/^[間份個次張杯天人歲]/.test(next)) return true;
  if (/^0\d{3,5}$/.test(raw) && /^(?:ETF|股票|股|代號)/i.test(next)) return true;
  return false;
}

function parseAmount(text) {
  const explicit = text.match(new RegExp(`(${AMOUNT_TOKEN_PATTERN})\\s*(?:元|圓|塊(?:錢)?)`));
  if (explicit) return numberFromAmountToken(explicit[1]);

  const candidates = [
    ...text.matchAll(
      /\d[\d,]*(?:\s*[十百千萬]\s*\d*)?|[零〇一二兩三四五六七八九十百千萬]+/g,
    ),
  ]
    .filter(match => !isNonAmountCandidate(text, match))
    .toSorted((left, right) => right.index - left.index);
  for (const candidate of candidates) {
    const amount = numberFromAmountToken(candidate[0]);
    if (amount) return amount;
  }
  return null;
}

function parseTransferFee(text) {
  const feeTerms = '(?:手續費|轉帳費|匯費)';
  const unit = '(?:元|圓|塊(?:錢)?)?';
  const patterns = [
    new RegExp(`${feeTerms}\\s*(?:為|是|共)?\\s*(${AMOUNT_TOKEN_PATTERN})\\s*${unit}`),
    new RegExp(`(${AMOUNT_TOKEN_PATTERN})\\s*${unit}\\s*${feeTerms}`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const fee = numberFromAmountToken(match?.[1] || '');
    if (fee) return fee;
  }
  return 0;
}

function withoutTransferFee(text) {
  const feeTerms = '(?:手續費|轉帳費|匯費)';
  const unit = '(?:元|圓|塊(?:錢)?)?';
  return text
    .replace(new RegExp(`${feeTerms}\\s*(?:為|是|共)?\\s*${AMOUNT_TOKEN_PATTERN}\\s*${unit}`, 'g'), ' ')
    .replace(new RegExp(`${AMOUNT_TOKEN_PATTERN}\\s*${unit}\\s*${feeTerms}`, 'g'), ' ');
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
  const full = text.match(/(20\d{2})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*[日號]?/);
  const short = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]/);
  const slash = text.match(/(?:^|\s)(\d{1,2})[./-](\d{1,2})(?:\s|$)/);
  const chinese = text.match(/([一二兩三四五六七八九十]+)月([一二兩三四五六七八九十]+)[日號]/);
  if (full && isValidDate(Number(full[1]), Number(full[2]), Number(full[3]))) {
    return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  }
  if (short && isValidDate(currentYear, Number(short[1]), Number(short[2]))) {
    return `${currentYear}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
  }
  if (slash && isValidDate(currentYear, Number(slash[1]), Number(slash[2]))) {
    return `${currentYear}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  }
  if (chinese) {
    const month = parseChineseNumber(chinese[1]);
    const day = parseChineseNumber(chinese[2]);
    if (isValidDate(currentYear, month, day)) {
      return `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  if (text.includes('大前天')) return shiftDate(today, -3);
  if (text.includes('前天')) return shiftDate(today, -2);
  if (text.includes('昨天') || text.includes('昨日')) return shiftDate(today, -1);
  if (text.includes('明天') || text.includes('明日')) return shiftDate(today, 1);
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
    .replace(/(?:NT\s*)?[$＄]\s*[\d,]+/gi, ' ')
    .replace(/(?:NT\s*)?[$＄]/gi, ' ')
    .replace(/(?:明天|明日|今天|昨日|昨天|大前天|前天|剛剛)/g, ' ')
    .replace(/(?:20\d{2}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日號]?/g, ' ')
    .replace(/[一二兩三四五六七八九十]+月[一二兩三四五六七八九十]+[日號]/g, ' ')
    .replace(/\d[\d,]*\s*(?:元|塊(?:錢)?)/g, ' ')
    .replace(/[零〇一二兩三四五六七八九十百千萬]+\s*(?:元|塊(?:錢)?)/g, ' ')
    .replace(/[\d,]+(?=\s*(?:用|刷|付|入|存|轉|匯|$))/g, ' ')
    .replace(/[零〇一二兩三四五六七八九十百千萬]+(?=\s*(?:用|刷|付|入|存|轉|匯|$))/g, ' ')
    .replace(/(?:line\s*(?:bank|pay)?|永豐|sinopac|台銀|臺銀|台灣銀行|臺灣銀行|郵局|中華郵政|刷卡|信用卡|卡片|銀行|帳戶|現金|付現|錢包|入帳)/gi, ' ')
    .replace(/(?:^|\s)(?:用|從|到|進)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function transactionName(text, type, classification) {
  if (type === 'transfer') return '帳戶轉帳';
  const cleaned = classificationText(text)
    .replace(/^(?:我|幫我|去|到|於|在|用)\s*/g, '')
    .replace(/^(?:買了?|吃了?|支付|繳了?)\s*/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || classification.subcategory || classification.topCategory || '未命名記錄';
}

export function conciseSpokenNote(value, primaryName = '') {
  const transcript = String(value ?? '').normalize('NFKC').trim().slice(0, 240);
  void primaryName;
  const companion = transcript.match(
    /(?:跟|和|與)\s*([^，、。,.!！?？\d$＄]{1,24}?)(?=(?:在|去|到|吃|喝|買|搭|繳|支付|付|轉|匯|刷|用|花|收|入|存))/,
  );
  const context = companion
    ? `與${companion[1].replace(/(?:一起|一同)$/g, '').trim()}`.slice(0, 36)
    : '';
  return context;
}

export function parseSpokenTransaction(value, options = {}) {
  const transcript = String(value ?? '').normalize('NFKC').trim().slice(0, 240);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const type = transactionType(transcript);
  const amount = parseAmount(type === 'transfer' ? withoutTransferFee(transcript) : transcript);
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
      fee: parseTransferFee(transcript),
      date,
      account: accountFromText(sourceText, 'sinopac'),
      toAccount: accountFromText(destinationText, 'cash'),
      category: null,
      subcategory: null,
      name: '帳戶轉帳',
      note: conciseSpokenNote(transcript, '帳戶轉帳'),
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

  const name = transactionName(transcript, type, classification);
  return {
    transcript,
    type,
    amount,
    date,
    account: accountFromText(transcript),
    toAccount: null,
    category: classification.topCategory,
    subcategory: classification.subcategory,
    name,
    note: conciseSpokenNote(transcript, name),
    classificationText: classificationText(transcript),
    confidence: Math.min(1, confidence),
  };
}
