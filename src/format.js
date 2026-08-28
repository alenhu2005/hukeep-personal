export function formatMoney(amount, options = {}) {
  const value = Number(amount) || 0;
  const formatted = new Intl.NumberFormat('zh-TW', {
    maximumFractionDigits: 0,
  }).format(Math.abs(value));
  const sign = value < 0 ? '-' : options.showPlus && value > 0 ? '+' : '';
  return `${sign}NT$ ${formatted}`;
}

export function formatCompactMoney(amount) {
  return new Intl.NumberFormat('zh-TW', {
    notation: Math.abs(amount) >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(amount || 0);
}

export function monthLabel(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${year} 年 ${monthNumber} 月`;
}

export function shortMonthLabel(month) {
  return `${Number(month.slice(5))} 月`;
}

export function formatDate(date) {
  const [, month, day] = String(date).split('-');
  return `${Number(month)}/${Number(day)}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function todayInTaipei() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
