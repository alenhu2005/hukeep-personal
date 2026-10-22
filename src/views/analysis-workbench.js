import { escapeHtml, formatCompactMoney, formatMoney, formatDate } from '../format.js';
import { analysisDisclosure, renderAnalysisTool } from './analysis-upgrades.js';
import { CATEGORY_TONES } from '../config.js';

const money = value => formatMoney(value);
const signed = value => formatMoney(value, { showPlus: true });
const empty = text => `<p class="workbench-empty">${escapeHtml(text)}</p>`;
const change = (now, before, hasData) => !hasData ? '無前期紀錄' : `${signed(now - before)}${before > 0 ? `（${Math.round((now / before - 1) * 100)}%）` : ''}`;
const attrs = fields => Object.entries(fields).filter(([, value]) => value !== '' && value != null)
  .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`).join(' ');
const categoryColor = category => ({ coral: 'var(--expense)', blue: 'var(--blue)', amber: 'var(--amber)', mint: 'var(--income)', olive: 'var(--primary)', violet: 'var(--category-violet)' }[CATEGORY_TONES[category]] || 'var(--primary)');

function metrics(items, label) {
  return `<dl class="workbench-metrics" aria-label="${escapeHtml(label)}">${items.map(([name, value, tone = '']) => `<div><dt>${name}</dt><dd class="${tone}">${value}</dd></div>`).join('')}</dl>`;
}

function comparisonNote(workspace) {
  const { comparison, observedRange } = workspace;
  if (!comparison.elapsedDays) return '<p class="workbench-caption">此期間尚未開始。</p>';
  return `<p class="workbench-caption">${formatDate(observedRange.from)}–${formatDate(observedRange.to)} · 前期 ${formatDate(comparison.range.from)}–${formatDate(comparison.range.to)}${comparison.hasData ? `（${comparison.count} 筆紀錄）` : '，無紀錄可比較'}</p>`;
}

function periodUnitLabel(period) {
  return period === 'week' ? '週' : period === 'year' ? '月' : '月';
}

function pointRange(point, field) {
  if (field === 'previousAmount' && point.previousKey) {
    const key = point.previousKey;
    return {
      start: key.length === 7 ? `${key}-01` : key,
      end: key.length === 7 ? new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 0)).toISOString().slice(0, 10) : key,
      date: key.length === 10 ? key : '',
      month: key.length === 7 ? key : '',
    };
  }
  if (field === 'previous' && point.previousRange) {
    return { start: point.previousRange.from, end: point.previousRange.to, date: '', month: '' };
  }
  if (point.currentRange) {
    return { start: point.currentRange.from, end: point.currentRange.to, date: '', month: '' };
  }
  if (point.from && point.to) {
    return { start: point.from, end: point.to, date: point.key?.length === 10 && point.from === point.to ? point.key : '', month: point.key?.length === 7 ? point.key : '' };
  }
  const key = point.key || '';
  return {
    start: key.length === 7 ? `${key}-01` : key,
    end: key.length === 7 ? new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 0)).toISOString().slice(0, 10) : key,
    date: key.length === 10 ? key : '',
    month: key.length === 7 ? key : '',
  };
}

function pointMarkup(point, series, fields) {
  return `<span class="workbench-point-date">${escapeHtml(point.longLabel || point.label)}${point.partial ? '（進行中）' : ''}</span><div>${series.map(item => {
    const value = point[item.field];
    if (value == null && item.optional) return '';
    if (item.noDrill) {
      return `<div class="workbench-readout-item is-static"><span style="--series-color:${item.color}"><i></i>${escapeHtml(item.label)}</span><strong>${value == null ? '—' : money(value)}</strong></div>`;
    }
    const rangeAttrs = pointRange(point, item.field);
    return `<button type="button" ${attrs({ 'analysis-drill': item.kind || fields['analysis-drill'], ...fields, ...(item.fields || {}), ...rangeAttrs })}><span style="--series-color:${item.color}"><i></i>${escapeHtml(item.label)}</span><strong>${money(value || 0)}</strong></button>`;
  }).filter(Boolean).join('')}</div>`;
}

export function updateAnalysisChartPoint(chart, index) {
  const model = JSON.parse(chart.dataset.chartModel);
  const position = Math.max(0, Math.min(model.rows.length - 1, Number(index) || 0));
  const select = chart.querySelector('[data-chart-point]');
  if (select) select.value = position;
  chart.querySelector('.workbench-chart-readout').innerHTML = pointMarkup(model.rows[position], model.series, model.fields);
  const marker = chart.querySelector('.workbench-chart-marker');
  if (marker) {
    const x = model.style === 'line'
      ? (model.rows.length <= 1 ? 362 : 96 + position * 532 / (model.rows.length - 1))
      : 96 + (position + .5) * 532 / model.rows.length;
    marker.setAttribute('x1', x);
    marker.setAttribute('x2', x);
  }
}

function chart(rows, series, label, fields = {}, options = {}) {
  if (!rows.length) return empty('這個期間尚無圖表資料。');
  const values = rows.flatMap(row => series.map(item => Number(row[item.field]) || 0));
  if (options.referenceValue > 0) values.push(options.referenceValue);
  const low = Math.min(0, ...values), high = Math.max(1, ...values);
  const y = value => 180 - (value - low) / (high - low) * 158;
  const width = 532 / rows.length;
  const ticks = options.allTicks && rows.length <= 12
    ? rows.map((_, index) => index)
    : [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  const initial = Math.max(0, rows.findLastIndex(row => series.some(item => row[item.field])));
  const model = { rows, series, fields, style: 'bar' };
  const refLine = options.referenceValue > 0
    ? `<line x1="96" x2="628" y1="${y(options.referenceValue)}" y2="${y(options.referenceValue)}" class="workbench-avg-line"/>`
    : '';
  return `<div class="workbench-chart" data-chart-model="${escapeHtml(JSON.stringify(model))}">
    <div class="workbench-legend">${series.map(item => `<span style="--series-color:${item.color}"><i></i>${escapeHtml(item.label)}</span>`).join('')}${options.referenceValue > 0 ? `<span class="is-dashed" style="--series-color:var(--ink-soft)"><i></i>${escapeHtml(options.referenceLabel || '平均')} ${money(options.referenceValue)}</span>` : ''}</div>
    <svg class="workbench-time-chart" viewBox="0 0 640 220" role="img" aria-label="${escapeHtml(label)}；可用下方日期選擇器查看數字">
      ${[low, (low + high) / 2, high].map(value => `<line x1="96" x2="628" y1="${y(value)}" y2="${y(value)}" class="workbench-grid"/><text x="86" y="${y(value) + 7}" text-anchor="end">${formatCompactMoney(Math.round(value))}</text>`).join('')}
      ${refLine}
      ${rows.map((row, index) => series.map((item, part) => {
        const value = row[item.field] || 0;
        const barX = 96 + index * width + width * (.1 + part * .8 / series.length);
        const barW = Math.max(2, width * .72 / series.length);
        const barY = Math.min(y(value), y(0));
        const barH = Math.abs(y(value) - y(0));
        return `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="2.5" fill="${item.color}"${row.partial ? ' fill-opacity="0.58" stroke-dasharray="3 2"' : ''}/>`;
      }).join('')).join('')}
      <line class="workbench-chart-marker" x1="${96 + (initial + .5) * width}" x2="${96 + (initial + .5) * width}" y1="18" y2="184"/>
      ${ticks.map(index => `<text x="${96 + (index + .5) * width}" y="212" text-anchor="${ticks.length > 3 ? 'middle' : index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${escapeHtml(rows[index].tick || rows[index].label)}</text>`).join('')}
    </svg>
    <label class="workbench-date-picker"><span>${escapeHtml(options.pickerLabel || '檢視日期')}</span><select data-chart-point aria-label="${escapeHtml(label)}日期">${rows.map((row, index) => `<option value="${index}"${index === initial ? ' selected' : ''}>${escapeHtml(row.label)}</option>`).join('')}</select></label>
    <div class="workbench-chart-readout" aria-live="polite">${pointMarkup(rows[initial], series, fields)}</div>
    ${analysisDisclosure(`${label}-values`, '完整數據', `${rows.length} 個時間點`, `<div class="workbench-data-list">${rows.map(row => `<div>${pointMarkup(row, series, fields)}</div>`).join('')}</div>`)}
  </div>`;
}

function paceChart(pace, label, fields = {}, options = {}) {
  const rows = pace?.rows || [];
  if (!rows.length || !pace.elapsed) return empty('這個期間尚無累計資料。');
  const hasPrev = pace.previousTotal != null;
  const hasBase = pace.baselineTotal != null && pace.baselineCount >= 2;
  const series = [
    { field: 'current', label: '本期累計', color: options.color || 'var(--expense)' },
    ...(hasPrev ? [{ field: 'previous', label: '上期同日累計', color: 'var(--ink-soft)', optional: true }] : []),
    ...(hasBase ? [{ field: 'baseline', label: `前 ${pace.baselineCount} 期平均步調`, color: 'var(--amber)', optional: true, noDrill: true }] : []),
  ];
  const values = [
    ...rows.flatMap(row => [row.current, row.previous, row.baseline].filter(v => v != null)),
    ...(options.budgetLimit > 0 ? [options.budgetLimit] : []),
    ...(pace.projected != null ? [pace.projected] : []),
  ];
  const high = Math.max(1, ...values);
  const x = index => rows.length <= 1 ? 362 : 96 + index * 532 / (rows.length - 1);
  const y = value => 180 - value / high * 158;
  const pathFor = (field, limit = rows.length) => {
    const pts = [];
    for (let index = 0; index < limit && index < rows.length; index += 1) {
      const value = rows[index][field];
      if (value != null) pts.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
    }
    return pts;
  };
  const currentPts = pathFor('current', pace.elapsed);
  const prevPts = hasPrev ? pathFor('previous') : [];
  const basePts = hasBase ? pathFor('baseline') : [];
  const areaPath = currentPts.length >= 2
    ? `M${x(0).toFixed(1)},180 L${currentPts.join(' L')} L${x(pace.elapsed - 1).toFixed(1)},180 Z`
    : '';
  const initial = Math.max(0, Math.min(rows.length - 1, pace.elapsed - 1));
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  const model = { rows, series, fields, style: 'line' };
  const diffFromBase = pace.baselineAtSamePoint != null ? pace.currentTotal - pace.baselineAtSamePoint : (pace.previousAtSamePoint != null ? pace.currentTotal - pace.previousAtSamePoint : null);
  const paceSummary = [
    diffFromBase != null ? `較同期${pace.baselineAtSamePoint != null && pace.baselineCount >= 2 ? '均值' : '上期'} ${signed(diffFromBase)}` : '',
    pace.partial && pace.projected != null ? `依歷史步調預估期末 ${money(pace.projected)}` : '',
    options.budgetLimit > 0 ? `月預算 ${money(options.budgetLimit)}` : '',
  ].filter(Boolean).join(' · ');
  const lastX = x(pace.elapsed - 1);
  const lastY = y(pace.currentTotal);
  return `<div class="workbench-chart workbench-pace-chart" data-chart-model="${escapeHtml(JSON.stringify(model))}">
    ${paceSummary ? `<p class="workbench-caption workbench-pace-summary">${escapeHtml(paceSummary)}</p>` : ''}
    <div class="workbench-legend">${series.map(item => `<span class="${item.noDrill ? 'is-dashed' : ''}" style="--series-color:${item.color}"><i></i>${escapeHtml(item.label)}</span>`).join('')}${options.budgetLimit > 0 ? `<span class="is-dashed" style="--series-color:var(--primary)"><i></i>預算上限</span>` : ''}</div>
    <svg class="workbench-time-chart" viewBox="0 0 640 220" role="img" aria-label="${escapeHtml(label)}；可用下方日期選擇器查看數字">
      ${[0, high / 2, high].map(value => `<line x1="96" x2="628" y1="${y(value)}" y2="${y(value)}" class="workbench-grid"/><text x="86" y="${y(value) + 7}" text-anchor="end">${formatCompactMoney(Math.round(value))}</text>`).join('')}
      ${options.budgetLimit > 0 ? `<line x1="96" x2="628" y1="${y(options.budgetLimit)}" y2="${y(options.budgetLimit)}" class="workbench-budget-line"/>` : ''}
      ${areaPath ? `<path d="${areaPath}" class="workbench-pace-area" style="--pace-color:${options.color || 'var(--expense)'}"/>` : ''}
      ${basePts.length >= 2 ? `<polyline points="${basePts.join(' ')}" class="workbench-pace-line is-baseline"/>` : ''}
      ${prevPts.length >= 2 ? `<polyline points="${prevPts.join(' ')}" class="workbench-pace-line is-previous"/>` : ''}
      ${currentPts.length >= 2 ? `<polyline points="${currentPts.join(' ')}" class="workbench-pace-line is-current" style="--pace-color:${options.color || 'var(--expense)'}"/>` : ''}
      ${pace.partial && pace.projected != null && pace.elapsed < rows.length ? `<line x1="${lastX.toFixed(1)}" y1="${lastY.toFixed(1)}" x2="${x(rows.length - 1).toFixed(1)}" y2="${y(pace.projected).toFixed(1)}" class="workbench-pace-projection" style="--pace-color:${options.color || 'var(--expense)'}"/><circle cx="${x(rows.length - 1).toFixed(1)}" cy="${y(pace.projected).toFixed(1)}" r="3.5" class="workbench-pace-dot is-projected" style="--pace-color:${options.color || 'var(--expense)'}"/>` : ''}
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4.5" class="workbench-pace-dot" style="--pace-color:${options.color || 'var(--expense)'}"/>
      <line class="workbench-chart-marker" x1="${x(initial)}" x2="${x(initial)}" y1="18" y2="184"/>
      ${ticks.map(index => `<text x="${x(index)}" y="212" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${escapeHtml(rows[index].label)}</text>`).join('')}
    </svg>
    <label class="workbench-date-picker"><span>檢視累計時間點</span><select data-chart-point aria-label="${escapeHtml(label)}日期">${rows.map((row, index) => `<option value="${index}"${index === initial ? ' selected' : ''}>${escapeHtml(row.label)}</option>`).join('')}</select></label>
    <div class="workbench-chart-readout" aria-live="polite">${pointMarkup(rows[initial], series, fields)}</div>
    ${analysisDisclosure(`${label}-values`, '完整數據', `${rows.length} 個時間點`, `<div class="workbench-data-list">${rows.map(row => `<div>${pointMarkup(row, series, fields)}</div>`).join('')}</div>`)}
  </div>`;
}

function ranking(groups, { key, type, category, subcategory, mark, accountNames = {}, previous = false, selected = '', drill = false }) {
  const max = Math.max(1, ...groups.map(row => Math.abs(row.amount)));
  return `<div class="analysis-ranked-bars workbench-ranking">${groups.map((row, index) => {
    const value = row[key];
    const label = accountNames[value] || value;
    const delta = previous && row.previousAmount > 0 ? row.amount - row.previousAmount : null;
    const deltaText = delta != null && delta !== 0 ? `（${delta > 0 ? '+' : ''}${Math.round((row.amount / row.previousAmount - 1) * 100)}%）` : '';
    return `<button type="button" style="--rank-color:${key === 'category' ? categoryColor(value) : 'var(--workbench-accent, var(--primary))'}" class="analysis-ranked-row${mark ? ' has-mark' : ''}${selected === value ? ' is-selected' : ''}" ${attrs(key === 'account' || drill ? { 'analysis-drill': type, category, subcategory, [key]: value } : { [`insight-${key}`]: value })}>
      ${mark ? mark(value) : ''}<span class="analysis-ranked-copy"><span><strong>${escapeHtml(label)}</strong><small>${row.percent}% · ${row.count} 筆</small></span><i><b style="width:${Math.abs(row.amount) / max * 100}%;opacity:${Math.max(.45, 1 - index * .08)}"></b></i></span>
      <span class="analysis-ranked-value"><strong>${money(row.amount)}</strong>${previous ? `<small>前期 ${money(row.previousAmount)}${deltaText}</small>` : ''}<span class="analysis-row-arrow" aria-hidden="true">›</span></span>
    </button>`;
  }).join('')}</div>`;
}

function modeButtons(filters, modes) {
  const active = modes.some(([key]) => key === filters.chartMode) ? filters.chartMode : modes[0][0];
  return `<div class="workbench-modes" role="group" aria-label="圖表內容">${modes.map(([key, label]) => `<button type="button" data-insight-chart-mode="${key}" aria-pressed="${active === key}">${label}</button>`).join('')}</div>`;
}

function overviewChart(workspace, filters) {
  const mode = ['trend', 'pace', 'current'].includes(filters.chartMode)
    ? filters.chartMode
    : (workspace.overviewTrend?.rows?.length || 0) >= 2
      ? 'trend'
      : 'current';
  const periodLabel = workspace.period === 'week' ? '近 8 週' : workspace.period === 'year' ? '各月' : '近 12 月';
  const modes = [
    ['trend', `${periodLabel}趨勢`],
    ['pace', '支出步調'],
    ['current', workspace.period === 'year' ? '各月明細' : '逐日收支'],
  ];
  let body;
  if (mode === 'pace') {
    body = paceChart(workspace.overviewPace, '生活支出累計步調', { 'analysis-drill': 'expense' }, { color: 'var(--expense)' });
  } else if (mode === 'current') {
    body = chart(workspace.incomeExpenseSeries, [
      { field: 'income', label: '收入', color: 'var(--income)', kind: 'income' },
      { field: 'expense', label: '生活支出', color: 'var(--expense)', kind: 'expense' },
    ], '收支走勢');
  } else {
    const trend = workspace.overviewTrend;
    const avgExpense = trend?.average?.expense;
    const avgCount = trend?.average?.count || 0;
    const caption = avgExpense != null && avgCount >= 2
      ? `<p class="workbench-caption">前 ${avgCount} 個完整${periodUnitLabel(workspace.period)}平均支出 ${money(avgExpense)} · 收入 ${money(trend.average.income || 0)}</p>`
      : '';
    body = `${chart(trend?.rows || [], [
      { field: 'income', label: '收入', color: 'var(--income)', kind: 'income' },
      { field: 'expense', label: '生活支出', color: 'var(--expense)', kind: 'expense' },
    ], '收支走勢', {}, {
      referenceValue: avgCount >= 2 ? avgExpense : 0,
      referenceLabel: '平均支出',
      pickerLabel: workspace.period === 'week' ? '檢視週次' : '檢視月份',
      allTicks: (trend?.rows?.length || 0) <= 8,
    })}${caption}`;
  }
  return `<div class="workbench-block"><div class="workbench-heading"><h3>收支走勢</h3>${modeButtons({ ...filters, chartMode: mode }, modes)}</div>${body}</div>`;
}

function overview(workspace, filters) {
  const current = workspace.totals, previous = workspace.previousTotals;
  const movers = workspace.expenseMovers;
  const useMovers = movers?.baselineCount >= 2 && movers.rows.length > 0;
  const changes = useMovers ? movers.rows.slice(0, 4) : workspace.expenseChanges.slice(0, 3);
  const dailyExpense = workspace.comparison.elapsedDays ? Math.round(current.expense / workspace.comparison.elapsedDays) : null;
  const summaryItems = [
    ['收入', money(current.income)],
    ['生活支出', money(current.expense)],
  ];
  return `<section class="workbench-panel" aria-label="總覽分析">
    <header class="workbench-heading"><h2>收支總覽</h2><span>${workspace.comparison.elapsedDays} 天${dailyExpense != null ? ` · 日均 ${money(dailyExpense)}` : ''} · 儲蓄率 ${workspace.savingsRate == null ? '—' : `${workspace.savingsRate}%`}</span></header>
    <div class="workbench-balance workbench-overview-balance"><span>生活結餘</span><strong class="${workspace.balance < 0 ? 'negative' : 'positive'}">${signed(workspace.balance)}</strong><small>${workspace.comparison.hasData ? `較前期 ${signed(workspace.balance - workspace.comparison.balance).replace('NT$ ', '')}` : '無前期紀錄'}</small></div>
    ${metrics(summaryItems, '收支摘要')}
    ${overviewChart(workspace, filters)}
    <div class="workbench-block"><h3>支出變化</h3>${useMovers
      ? `<p class="workbench-caption">${formatDate(movers.window.from)}–${formatDate(movers.window.to)} · 對照前 ${movers.baselineCount} 期同期平均</p>`
      : comparisonNote(workspace)}${(useMovers || workspace.comparison.hasData) && changes.length ? `<div class="workbench-changes">${changes.map(row => {
      const base = useMovers ? row.baseline : row.previousAmount;
      const diff = useMovers ? row.change : row.changeAmount;
      const baseLabel = useMovers ? `前 ${movers.baselineCount} 期均` : '前期';
      return `<button type="button" data-insight-jump-category="${escapeHtml(row.category)}"><span>${escapeHtml(row.category)}<small>本期 ${money(row.amount)} · ${baseLabel} ${money(base)}</small></span><strong class="${diff > 0 ? 'is-up' : 'is-down'}">${signed(diff)}</strong><span aria-hidden="true">›</span></button>`;
    }).join('')}</div>` : empty('有前期紀錄後，這裡會列出變動最大的分類。')}
    ${analysisDisclosure('overview-comparison', '完整前期比較', '收入、生活支出與結餘', `<div class="workbench-comparisons">${[['收入', current.income, previous.income], ['生活支出', current.expense, previous.expense], ['生活結餘', workspace.balance, workspace.comparison.balance]].map(([label, value, before]) => `<div><strong>${label}</strong><span>本期 ${money(value)}</span><span>前期 ${workspace.comparison.hasData ? money(before) : '—'}</span><b>${change(value, before, workspace.comparison.hasData)}</b></div>`).join('')}</div>`)}</div>
    ${filters.tool ? renderAnalysisTool(workspace, filters) : ''}
  </section>`;
}

function sectionOverviewChart(workspace, filters, type, label) {
  const trend = workspace.sectionTrend;
  const pace = workspace.sectionPace;
  if (!trend?.rows?.length) return '';
  const periodLabel = workspace.period === 'week' ? '近 8 週' : workspace.period === 'year' ? '各月' : '近 12 月';
  const modes = [['trend', `${periodLabel}走勢`], ['pace', '累計步調']];
  const mode = filters.chartMode === 'pace' ? 'pace' : 'trend';
  const color = type === 'income' ? 'var(--income)' : 'var(--expense)';
  const avg = trend.average?.amount;
  const avgCount = trend.average?.count || 0;
  const body = mode === 'pace'
    ? paceChart(pace, `${label}累計步調`, { 'analysis-drill': type }, { color })
    : chart(trend.rows, [{ field: 'amount', label: `總${label}`, color, kind: type }], `${label}跨期走勢`, { 'analysis-drill': type }, {
        referenceValue: avgCount >= 2 ? avg : 0,
        referenceLabel: `前 ${avgCount} ${periodUnitLabel(workspace.period)}均`,
        pickerLabel: workspace.period === 'week' ? '檢視週次' : '檢視月份',
        allTicks: trend.rows.length <= 8,
      });
  return `<div class="workbench-block"><h3>${label}趨勢</h3>${modeButtons({ ...filters, chartMode: mode }, modes)}${body}</div>`;
}

function categoryChart(state, workspace, filters, type) {
  const focus = workspace.focus;
  const title = focus.subcategory || focus.category;
  const fields = { 'analysis-drill': type, category: focus.category, subcategory: focus.subcategory };
  const selected = workspace[`${type}ComparisonSeries`].find(row => row.category === focus.category);
  const comparison = focus.subcategory ? selected?.children.find(row => row.subcategory === focus.subcategory) : selected;
  const periodLabel = workspace.period === 'week' ? '跨週' : workspace.period === 'year' ? '各月' : '跨月';
  const modes = [['current', '期間走勢'], ['trend', periodLabel], ['pace', '累計步調'], ['previous', '前期比較']];
  if (!focus.subcategory && focus.children.length >= 2) modes.push(['multi', '比較小分類']);
  const mode = modes.some(([key]) => key === filters.chartMode) ? filters.chartMode : 'current';
  const accent = 'var(--workbench-accent, var(--primary))';
  const budget = !focus.subcategory && type === 'expense' && workspace.period === 'month'
    ? (state.budgets || []).find(item => item.category === focus.category)?.limit || 0
    : 0;
  let body;
  if (mode === 'trend') {
    const trend = focus.trend;
    const avg = trend?.average?.amount;
    const avgCount = trend?.average?.count || 0;
    const series = [
      { field: 'amount', label: title, color: accent },
      ...(workspace.period === 'year' && trend?.hasPrevious ? [{ field: 'previousAmount', label: '去年同月', color: 'var(--muted)' }] : []),
    ];
    body = chart(trend?.rows || [], series, `${title}${periodLabel}`, fields, {
      referenceValue: avgCount >= 2 ? avg : 0,
      referenceLabel: `前 ${avgCount} ${periodUnitLabel(workspace.period)}均`,
      pickerLabel: workspace.period === 'week' ? '檢視週次' : '檢視月份',
      allTicks: (trend?.rows?.length || 0) <= 8,
    });
  } else if (mode === 'pace') {
    body = paceChart(focus.pace, `${title}累計步調`, fields, { color: categoryColor(focus.category), budgetLimit: budget });
  } else if (mode === 'previous') {
    body = `${comparisonNote(workspace)}${workspace.comparison.hasData ? chart(comparison?.series || [], [
      { field: 'amount', label: '本期', color: 'var(--primary)' },
      { field: 'previousAmount', label: '前期', color: 'var(--muted)' },
    ], `${title}前期比較`, fields) : empty('前期沒有紀錄，暫不計算增減百分比。')}`;
  } else if (mode === 'multi' && !focus.subcategory) {
    const names = filters.compareSubcategories || [];
    const children = (selected?.children || []).filter(row => names.includes(row.subcategory));
    body = `<p class="workbench-caption">選擇 2–3 個小分類，使用相同比例尺。</p><div class="workbench-chips">${focus.children.map(child => `<button type="button" data-insight-compare-subcategory="${escapeHtml(child.subcategory)}" aria-pressed="${names.includes(child.subcategory)}">${escapeHtml(child.subcategory)}</button>`).join('')}</div>`;
    body += children.length < 2 ? empty('先選兩個小分類開始比較。') : chart(children[0].series.map((row, index) => ({ ...row, ...Object.fromEntries(children.map((child, part) => [`part${part}`, child.series[index]?.amount || 0])) })), children.map((child, index) => ({ field: `part${index}`, label: child.subcategory, color: ['var(--primary)', 'var(--amber)', 'var(--muted)'][index], fields: { subcategory: child.subcategory } })), `${focus.category}小分類比較`, fields);
  } else {
    const avg = focus.trend?.average?.amount;
    const avgCount = focus.trend?.average?.count || 0;
    const hint = avg != null && avgCount >= 2 ? `<p class="workbench-caption">過去 ${avgCount} 個完整${periodUnitLabel(workspace.period)}平均 ${money(avg)}${focus.pace?.partial && focus.pace?.projected != null ? ` · 本期預估 ${money(focus.pace.projected)}` : ''}</p>` : '';
    body = `${hint}${chart(focus.timeSeries, [{ field: 'amount', label: title, color: accent }], `${title}期間趨勢`, fields)}`;
  }
  return `<div class="workbench-block"><h3>${escapeHtml(title)}走勢</h3>${modeButtons({ ...filters, chartMode: mode }, modes)}${body}</div>`;
}

function category(state, workspace, filters, helpers) {
  const type = filters.section, label = type === 'income' ? '收入' : '支出';
  const groups = workspace[`${type}Groups`];
  const focus = workspace.focus;
  const accountNames = Object.fromEntries(state.accounts.map(item => [item.id, item.name]));
  const tools = type === 'expense' ? [['budget', '預算走勢'], ['merchants', '商家與品項'], ['composition', '小分類構成']] : [['composition', '小分類構成']];
  if (filters.category && (!focus || filters.subcategory && focus.subcategory !== filters.subcategory)) return `<section class="workbench-panel"><h2>${escapeHtml(filters.subcategory || filters.category)}</h2>${empty('這個期間沒有符合的紀錄。可切換期間，或返回上層分類。')}<button type="button" data-insight-${filters.subcategory ? 'subcategory' : 'category'}="">返回${filters.subcategory ? '大分類' : '全部分類'}</button></section>`;
  const title = focus?.subcategory || focus?.category || `${label}分類`;
  const amount = focus?.amount ?? workspace.totals[type];
  const focusAvg = focus?.trend?.average?.amount;
  const focusAvgCount = focus?.trend?.average?.count || 0;
  const sectionAvg = workspace.sectionTrend?.average?.amount;
  const sectionAvgCount = workspace.sectionTrend?.average?.count || 0;
  return `<section class="workbench-panel${focus ? ' analysis-focus' : ''}" style="--workbench-accent:${categoryColor(focus?.category)}" aria-label="${label}分類分析">
    <header class="workbench-heading"><h2 tabindex="-1">${escapeHtml(title)}</h2>${focus ? `<button type="button" data-insight-${focus.subcategory ? 'subcategory' : 'category'}="" aria-label="返回${focus.subcategory ? '大分類' : '全部大分類'}">‹ 返回</button>` : ''}</header>
    <div class="workbench-balance"><span>本期${label}</span><strong>${money(amount)}</strong>${focus
      ? `<small>${focus.percent}% · ${focus.count} 筆 · 前期 ${workspace.comparison.hasData ? money(focus.previousAmount) : '—'}${focusAvg != null && focusAvgCount >= 2 ? ` · 近 ${focusAvgCount} 期均 ${money(focusAvg)}` : ''}</small>`
      : sectionAvg != null && sectionAvgCount >= 2
        ? `<small>前 ${sectionAvgCount} 個完整${periodUnitLabel(workspace.period)}平均 ${money(sectionAvg)}${workspace.sectionPace?.partial && workspace.sectionPace?.projected != null ? ` · 本期預估 ${money(workspace.sectionPace.projected)}` : ''}</small>`
        : ''}</div>
    ${focus ? metrics([['期間日平均', workspace.comparison.elapsedDays ? money(Math.round(amount / workspace.comparison.elapsedDays)) : '—'], [focus.subcategory ? `占${escapeHtml(focus.category)}` : `占總${label}`, `${focus.percent}%`]], `${title}摘要`) : ''}
    ${!focus ? groups.length ? `${ranking(groups, { key: 'category', type, mark: helpers.categoryMark, previous: workspace.comparison.hasData })}${sectionOverviewChart(workspace, filters, type, label)}` : empty(`本期沒有${label}紀錄。`) : !focus.subcategory ? `<div class="workbench-block" role="region" aria-label="${escapeHtml(focus.category)}小分類圖表"><h3>小分類排行</h3>${ranking(focus.children, { key: 'subcategory', type, previous: workspace.comparison.hasData })}</div>` : ''}
    ${focus ? categoryChart(state, workspace, filters, type) : ''}
    ${focus ? analysisDisclosure(`${type}-${focus.category}-${focus.subcategory}-accounts`, `${type === 'expense' ? '付款' : '入帳'}帳戶`, `${focus.accounts.length} 個帳戶`, ranking(focus.accounts, { key: 'account', type, category: focus.category, subcategory: focus.subcategory, accountNames })) : ''}
    ${focus ? analysisDisclosure(`${type}-${title}-stats`, '詳細統計', '筆數、平均每筆與前期差額', metrics([['筆數', `${focus.count} 筆`], ['平均每筆', money(focus.average)], ['前期差額', change(focus.amount, focus.previousAmount, workspace.comparison.hasData)]], `${title}詳細統計`)) : ''}
    ${focus?.subcategory ? `<div class="workbench-block"><div class="workbench-heading"><h3>${escapeHtml(title)}明細</h3><span>${focus.count} 筆</span></div><div class="transaction-list compact workbench-transactions">${helpers.transactions(focus.transactions, type)}</div></div>` : ''}
    ${focus ? analysisDisclosure(`${type}-${focus.category}-switch`, '切換大分類', `${groups.length} 個分類`, ranking(groups, { key: 'category', type, mark: helpers.categoryMark, selected: focus.category })) : ''}
    ${analysisDisclosure(`${type}-tools`, '更多分析', '', `<div class="workbench-tools" role="group" aria-label="更多分析">${tools.filter(([key]) => key !== 'composition' || focus && !focus.subcategory).map(([key, text]) => `<button type="button" data-insight-tool="${key}" aria-pressed="${filters.tool === key}">${text}</button>`).join('')}</div>${filters.tool ? renderAnalysisTool(workspace, filters) : ''}`, Boolean(filters.tool))}
  </section>`;
}

function investment(state, workspace, filters, helpers) {
  const flow = workspace.investmentFlows;
  const assetFilter = filters.assetAccount || 'all';
  return `<section class="workbench-panel investment-analysis" aria-label="投資分析">
    <header class="workbench-heading"><h2>投資資產</h2><span>新臺幣</span></header>
    <div class="workbench-modes" role="group" aria-label="市值帳戶">${[['all', '全部'], ['investment', '股票'], ['bito', 'Bito']].map(([key, text]) => `<button type="button" data-insight-asset="${key}" aria-pressed="${assetFilter === key}">${text}</button>`).join('')}</div>
    ${modeButtons(filters, [['current', '市值變化'], ['flow', '資金流向']])}
    ${helpers.assets(filters)}
    <div class="workbench-block"><h3>投資流向</h3>${metrics([['投入', money(flow.contributed)], ['領回', money(flow.withdrawn)], ['淨投入', signed(flow.net)]], '投資摘要')}
    ${filters.chartMode === 'flow' ? chart(workspace.investmentSeries, [{ field: 'contributed', label: '投入', color: 'var(--amber)' }, { field: 'withdrawn', label: '領回', color: 'var(--muted)' }], '投資流向', { 'analysis-drill': 'investment' }) : ''}</div>
    ${workspace.investmentGroups.length ? analysisDisclosure('investment-categories', '資金細分類', `${workspace.investmentGroups.length} 種資產`, `<div class="workbench-changes">${workspace.investmentGroups.map(group => `<button type="button" data-analysis-drill="investment" data-subcategory="${escapeHtml(group.subcategory)}"><span>${escapeHtml(group.subcategory)}<small>投入 ${money(group.contributed)} · 領回 ${money(group.withdrawn)}</small></span><strong>${signed(group.net)}</strong></button>`).join('')}</div>`) : ''}
    ${analysisDisclosure('investment-income-costs', '投資相關收支', `收入 ${money(workspace.investmentIncome?.amount || 0)} · 支出 ${money(workspace.investmentCost)}`, `<h3>股息、配息與利息</h3>${workspace.investmentIncome ? ranking(workspace.investmentIncome.children, { key: 'subcategory', type: 'income', category: '投資', drill: true }) : empty('本期沒有投資收入。')}<h3>手續費、稅與工具課程</h3><div class="transaction-list compact workbench-transactions">${helpers.transactions(workspace.investmentCostTransactions, 'expense')}</div>`)}
    <div class="workbench-tools"><button type="button" data-insight-tool="principal" aria-pressed="${filters.tool === 'principal'}">查看資產與本金歷史</button></div>
    ${filters.tool ? renderAnalysisTool(workspace, filters) : ''}
  </section>`;
}

export function renderAnalysisWorkbench(state, workspace, filters, helpers) {
  if (filters.section === 'investment') return investment(state, workspace, filters, helpers);
  if (filters.section === 'expense' || filters.section === 'income') return category(state, workspace, filters, helpers);
  return overview(workspace, filters);
}
