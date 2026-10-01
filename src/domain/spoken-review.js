const ACCOUNT_CUES = [
  [/line\s*(?:bank|pay)?/i, 'line'],
  [/(?:永豐|sinopac|信用卡|刷卡|卡片)/i, 'sinopac'],
  [/(?:台銀|臺銀|台灣銀行|臺灣銀行)/, 'bot'],
  [/(?:郵局|中華郵政)/, 'post'],
  [/(?:現金|付現|錢包)/, 'cash'],
];

function explicitAccounts(text) {
  return [...new Set(ACCOUNT_CUES.filter(([pattern]) => pattern.test(text)).map(([, id]) => id))];
}

/** Returns review reasons for multi-item speech; parsing and transaction data stay untouched. */
export function detectSpokenReview(value, entries) {
  const transcript = String(value ?? '').normalize('NFKC').trim();
  if (!Array.isArray(entries) || entries.length < 2) {
    return { needsReview: false, reasons: [], itemIndexes: [] };
  }

  const reasons = [];
  const itemIndexes = [];
  entries.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry?.amount) || entry.amount <= 0) {
      reasons.push('amount');
      itemIndexes.push(index);
    }
    if (!String(entry?.name ?? '').trim() || /^(?:未命名記錄|其他|項目\d*)$/.test(entry.name.trim())) {
      reasons.push('item');
      itemIndexes.push(index);
    }
  });

  const accounts = explicitAccounts(transcript);
  const fragments = transcript.split(/(?:、|，|；|;|。|,(?!\d)|還有|以及|跟|和)+/).map(part => part.trim());
  const itemAccountsMapped = entries.every((entry, index) => {
    const item = String(entry?.classificationText ?? entry?.name ?? '');
    const ordinal = index === 0 ? /(?:第一(?:個|項)?|前者|前一個)/ : /(?:第二(?:個|項)?|後者|另一個|下一個)/;
    return fragments.some(fragment =>
      (item && fragment.includes(item) || ordinal.test(fragment)) && explicitAccounts(fragment).length > 0,
    );
  });
  if (!accounts.length || (accounts.length > 1 && !itemAccountsMapped)) {
    reasons.push('account');
    itemIndexes.push(...entries.map((_, index) => index));
  }

  return {
    needsReview: reasons.length > 0,
    reasons: [...new Set(reasons)],
    itemIndexes: [...new Set(itemIndexes)].sort((a, b) => a - b),
  };
}
