import { expenseAmount, expenseCategory, incomeAmount, isAccountingAdjustment } from './insights.js';

/**
 * 跨期趨勢、累計步調與分類變化。
 *
 * 這裡的計算都只走過一次交易資料，避免趨勢頁每次重繪時隨交易數量平方成長。
 * 「期間」沿用分析頁的 week / month / year；趨勢會往回看同粒度的前幾期，
 * 年度則以當年各月呈現並附上去年同月。
 */

export const TREND_LENGTH = Object.freeze({ week: 8, month: 12, year: 12 });
export const PACE_LOOKBACK = 3;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function addDays(value, days) {
  const date = validDate(value);
  if (!date) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = validDate(from);
  const end = validDate(to);
  return start && end ? Math.round((end - start) / 86_400_000) : 0;
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function shortDate(date) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function categoryFor(transaction, type) {
  return type === 'income' ? transaction.category || '其他收入' : expenseCategory(transaction);
}

function subcategoryFor(transaction) {
  return transaction.type === 'transfer' ? '轉帳手續費' : transaction.subcategory || '未細分';
}

function amountFor(transaction, type) {
  if (isAccountingAdjustment(transaction)) return 0;
  return type === 'income' ? incomeAmount(transaction) : expenseAmount(transaction);
}

function matchesFilter(transaction, filter, type) {
  if (!filter?.category) return true;
  if (categoryFor(transaction, type) !== filter.category) return false;
  return !filter.subcategory || subcategoryFor(transaction) === filter.subcategory;
}

function percentChange(current, base) {
  return base > 0 ? Math.round((current / base - 1) * 100) : null;
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/** 取得與目前期間同粒度、往回推的期間清單（由舊到新）。 */
export function trendBuckets(period, range, count = TREND_LENGTH[period] || 12) {
  if (!validDate(range?.from)) return [];
  if (period === 'year') {
    const year = range.from.slice(0, 4);
    return Array.from({ length: 12 }, (_, index) => {
      const month = `${year}-${String(index + 1).padStart(2, '0')}`;
      return {
        key: month, from: `${month}-01`, to: monthEnd(month),
        label: `${index + 1}月`, longLabel: `${year} 年 ${index + 1} 月`,
        goto: { month },
      };
    });
  }
  if (period === 'week') {
    return Array.from({ length: count }, (_, index) => {
      const from = addDays(range.from, -7 * (count - 1 - index));
      const to = addDays(from, 6);
      return {
        key: from, from, to,
        label: shortDate(from), longLabel: `${shortDate(from)}–${shortDate(to)}`,
        goto: { week: from },
      };
    });
  }
  const selected = range.from.slice(0, 7);
  return Array.from({ length: count }, (_, index) => {
    const month = shiftMonth(selected, index - count + 1);
    const monthNumber = Number(month.slice(5));
    return {
      key: month, from: `${month}-01`, to: monthEnd(month),
      label: monthNumber === 1 || index === 0 ? `${month.slice(2, 4)}/${monthNumber}月` : `${monthNumber}月`,
      longLabel: `${month.slice(0, 4)} 年 ${monthNumber} 月`,
      goto: { month },
    };
  });
}

/**
 * 建立跨期收支或單一分類的趨勢。
 * - 未來期間不顯示；進行中的期間標記 partial，並截到今天。
 * - 前面完全沒有紀錄的期間會被裁掉，剛開始記帳時不會出現一排空白。
 * - average 只取「已結束」的期間，不讓進行中的本期拉低平均。
 */
export function buildTrendSeries(transactions, options = {}) {
  const period = ['week', 'month', 'year'].includes(options.period) ? options.period : 'month';
  const currentDate = validDate(options.currentDate) ? options.currentDate : '9999-12-31';
  const type = options.type || '';
  const filter = options.filter || null;
  const buckets = trendBuckets(period, options.range, options.count)
    .filter(bucket => bucket.from <= currentDate)
    .map(bucket => ({ ...bucket, to: bucket.to > currentDate ? currentDate : bucket.to, partial: bucket.to > currentDate }));
  if (!buckets.length) return { rows: [], average: {}, hasPrevious: false };
  const first = buckets[0].from;
  const last = buckets.at(-1).to;
  const previousYearFrom = period === 'year' ? `${Number(first.slice(0, 4)) - 1}${first.slice(4)}` : '';
  const previousYearTo = period === 'year' ? `${Number(last.slice(0, 4)) - 1}${last.slice(4)}` : '';
  const indexFor = date => {
    if (period === 'week') return Math.floor(daysBetween(first, date) / 7);
    return buckets.findIndex(bucket => bucket.key === date.slice(0, 7));
  };
  const rows = buckets.map(bucket => ({ ...bucket, income: 0, expense: 0, amount: 0, count: 0, previousAmount: 0, previousExpense: 0, previousIncome: 0 }));
  let previousYearHasData = false;
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const date = transaction?.date;
    if (!validDate(date)) continue;
    if (period === 'year' && date >= previousYearFrom && date <= previousYearTo) {
      const index = Number(date.slice(5, 7)) - 1;
      const row = rows[index];
      if (!row) continue;
      if (type) {
        if (!matchesFilter(transaction, filter, type)) continue;
        const value = amountFor(transaction, type);
        if (value) { row.previousAmount += value; previousYearHasData = true; }
      } else {
        const income = amountFor(transaction, 'income');
        const expense = amountFor(transaction, 'expense');
        row.previousIncome += income;
        row.previousExpense += expense;
        if (income || expense) previousYearHasData = true;
      }
      continue;
    }
    if (date < first || date > last) continue;
    const row = rows[indexFor(date)];
    if (!row || date > row.to) continue;
    if (type) {
      if (!matchesFilter(transaction, filter, type)) continue;
      const value = amountFor(transaction, type);
      if (!value) continue;
      row.amount += value;
      row.count += 1;
    } else {
      const income = amountFor(transaction, 'income');
      const expense = amountFor(transaction, 'expense');
      if (!income && !expense) continue;
      row.income += income;
      row.expense += expense;
      row.count += 1;
    }
  }
  rows.forEach(row => { row.net = row.income - row.expense; });
  const firstActive = period === 'year' ? 0 : rows.findIndex(row => row.count > 0);
  const visible = firstActive < 0 ? rows.slice(-1) : rows.slice(Math.min(firstActive, rows.length - 1));
  const complete = visible.filter(row => !row.partial && row !== visible.at(-1) || !row.partial && period === 'year');
  const settled = period === 'year' ? visible.filter(row => !row.partial) : complete;
  return {
    period,
    rows: visible,
    average: {
      income: average(settled.map(row => row.income)),
      expense: average(settled.map(row => row.expense)),
      amount: average(settled.map(row => row.amount)),
      count: settled.length,
    },
    hasPrevious: period === 'year' ? previousYearHasData : visible.length > 1,
  };
}

function shiftPeriodRange(period, range, offset) {
  if (period === 'week') return { from: addDays(range.from, 7 * offset), to: addDays(range.to, 7 * offset) };
  if (period === 'year') {
    const year = Number(range.from.slice(0, 4)) + offset;
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const month = shiftMonth(range.from.slice(0, 7), offset);
  return { from: `${month}-01`, to: monthEnd(month) };
}

function positionFor(period, from, date) {
  return period === 'year' ? Number(date.slice(5, 7)) - 1 : daysBetween(from, date);
}

function positionCount(period, range) {
  return period === 'year' ? 12 : daysBetween(range.from, range.to) + 1;
}

function positionEnd(period, range, index) {
  if (period === 'year') {
    const month = `${range.from.slice(0, 4)}-${String(index + 1).padStart(2, '0')}`;
    return monthEnd(month);
  }
  return addDays(range.from, index);
}

/**
 * 累計步調：本期每天（年度為每月）累計金額，對照上一期與前幾期平均。
 * 預估期末金額使用「過去幾期在剩餘天數通常還會花多少」，
 * 房租等固定月初／月中支出不會被線性外推放大。
 */
export function buildPace(transactions, options = {}) {
  const period = ['week', 'month', 'year'].includes(options.period) ? options.period : 'month';
  const range = options.range;
  if (!validDate(range?.from) || !validDate(range?.to)) return { rows: [], elapsed: 0, length: 0 };
  const type = options.type || 'expense';
  const filter = options.filter || null;
  const lookback = options.lookback ?? PACE_LOOKBACK;
  const currentDate = validDate(options.currentDate) ? options.currentDate : '9999-12-31';
  const length = positionCount(period, range);
  const ranges = Array.from({ length: lookback + 1 }, (_, offset) => offset ? shiftPeriodRange(period, range, -offset) : range);
  const daily = ranges.map(() => Array(Math.max(length, 31)).fill(0));
  const active = ranges.map(() => false);
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const date = transaction?.date;
    if (!validDate(date)) continue;
    const index = ranges.findIndex(item => date >= item.from && date <= item.to);
    if (index < 0 || (index === 0 && date > currentDate) || !matchesFilter(transaction, filter, type)) continue;
    const value = amountFor(transaction, type);
    if (!value) continue;
    daily[index][positionFor(period, ranges[index].from, date)] += value;
    active[index] = true;
  }
  const cumulative = daily.map((values, index) => {
    const count = positionCount(period, ranges[index]);
    let sum = 0;
    // 較短的月份在缺少的日子沿用最後累計，讓 31 日也能對照 30 日的上個月。
    return Array.from({ length }, (_, position) => (position < count ? (sum += values[position]) : sum));
  });
  const elapsed = range.from > currentDate ? 0 : range.to <= currentDate ? length : positionFor(period, range.from, currentDate) + 1;
  const baselineIndexes = ranges.map((_, index) => index).filter(index => index > 0 && active[index]);
  const baseline = baselineIndexes.length
    ? Array.from({ length }, (_, position) => Math.round(baselineIndexes.reduce((sum, index) => sum + cumulative[index][position], 0) / baselineIndexes.length))
    : null;
  const previousRange = ranges[1];
  const rows = Array.from({ length }, (_, position) => {
    const end = positionEnd(period, range, position);
    const previousEnd = previousRange ? (period === 'year' ? positionEnd(period, previousRange, position) : addDays(previousRange.from, Math.min(position, positionCount(period, previousRange) - 1))) : '';
    return {
      key: end,
      label: period === 'year' ? `${position + 1}月` : period === 'week' ? `${WEEKDAYS[validDate(end).getUTCDay()]} ${shortDate(end)}` : shortDate(end),
      tick: period === 'year' ? `${position + 1}月` : period === 'week' ? WEEKDAYS[validDate(end).getUTCDay()] : String(Number(end.slice(8))),
      current: position < elapsed ? cumulative[0][position] : null,
      previous: active[1] ? cumulative[1][position] : null,
      baseline: baseline ? baseline[position] : null,
      currentRange: { from: range.from, to: end > currentDate ? currentDate : end },
      previousRange: previousRange ? { from: previousRange.from, to: previousEnd } : null,
    };
  });
  const at = (values, index) => (values && index >= 0 ? values[Math.min(index, length - 1)] : null);
  const currentTotal = elapsed ? cumulative[0][elapsed - 1] : 0;
  const partial = elapsed > 0 && elapsed < length;
  let projected = null;
  if (partial) {
    projected = baseline
      ? currentTotal + Math.max(0, baseline[length - 1] - baseline[elapsed - 1])
      : Math.round(currentTotal / elapsed * length);
  }
  return {
    period,
    type,
    rows,
    elapsed,
    length,
    partial,
    currentTotal,
    previousAtSamePoint: active[1] ? at(cumulative[1], elapsed - 1) : null,
    previousTotal: active[1] ? cumulative[1][length - 1] : null,
    baselineAtSamePoint: baseline ? at(baseline, elapsed - 1) : null,
    baselineTotal: baseline ? baseline[length - 1] : null,
    baselineCount: baselineIndexes.length,
    projected,
    projectionMethod: partial ? (baseline ? 'history' : 'linear') : '',
  };
}

/**
 * 分類變化：本期至今與前幾期「同一時間點」平均相比，
 * 比只看上一期穩定，單月特殊支出不會讓排行大幅跳動。
 */
export function buildCategoryMovers(transactions, options = {}) {
  const period = ['week', 'month', 'year'].includes(options.period) ? options.period : 'month';
  const range = options.range;
  if (!validDate(range?.from)) return { rows: [], baselineCount: 0 };
  const type = options.type || 'expense';
  const lookback = options.lookback ?? PACE_LOOKBACK;
  const currentDate = validDate(options.currentDate) ? options.currentDate : '9999-12-31';
  const elapsedEnd = range.to < currentDate ? range.to : currentDate;
  if (range.from > elapsedEnd) return { rows: [], baselineCount: 0 };
  const elapsedDays = daysBetween(range.from, elapsedEnd);
  const windows = Array.from({ length: lookback + 1 }, (_, offset) => {
    const shifted = offset ? shiftPeriodRange(period, range, -offset) : range;
    const to = addDays(shifted.from, elapsedDays);
    return { from: shifted.from, to: to > shifted.to ? shifted.to : to };
  });
  const totals = windows.map(() => new Map());
  const active = windows.map(() => false);
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const date = transaction?.date;
    if (!validDate(date)) continue;
    const index = windows.findIndex(window => date >= window.from && date <= window.to);
    if (index < 0) continue;
    const value = amountFor(transaction, type);
    if (!value) continue;
    const category = categoryFor(transaction, type);
    totals[index].set(category, (totals[index].get(category) || 0) + value);
    active[index] = true;
  }
  const baselineIndexes = windows.map((_, index) => index).filter(index => index > 0 && active[index]);
  if (!baselineIndexes.length) return { rows: [], baselineCount: 0, window: windows[0] };
  const names = new Set(totals.flatMap(map => [...map.keys()]));
  const rows = [...names].map(category => {
    const amount = totals[0].get(category) || 0;
    const baseline = Math.round(baselineIndexes.reduce((sum, index) => sum + (totals[index].get(category) || 0), 0) / baselineIndexes.length);
    return { category, amount, baseline, change: amount - baseline, changePercent: percentChange(amount, baseline) };
  })
    .filter(row => row.change !== 0)
    .toSorted((left, right) => Math.abs(right.change) - Math.abs(left.change) || left.category.localeCompare(right.category));
  return { rows, baselineCount: baselineIndexes.length, window: windows[0] };
}
