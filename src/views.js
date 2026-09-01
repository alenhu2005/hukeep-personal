import { CATEGORY_TONES, EXPENSE_CATEGORIES, TYPE_LABELS } from './config.js';
import {
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateTotalAssets,
  summarizeMonth,
} from './domain/insights.js';
import { filterTransactions } from './domain/transactions.js';
import { findTransactionSignals, reconciliationStatus } from './domain/ledger-enhancements.js';
import { buildAnalysisWorkspace } from './domain/analysis-workspace.js';
import { escapeHtml, formatCompactMoney, formatDate, formatMoney, monthLabel, todayInTaipei } from './format.js';
import { icon } from './icons.js';

function emptyState(title, body = '') {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><strong>${title}</strong>${body ? `<p>${body}</p>` : ''}</div>`;
}

function categoryMark(category) {
  const tone = CATEGORY_TONES[category] || 'slate';
  return `<span class="category-mark tone-${tone}" aria-hidden="true">${escapeHtml(category?.slice(0, 1) || '其')}</span>`;
}

export function transactionRows(transactions, accounts, options = {}) {
  if (!transactions.length) {
    return emptyState('沒有符合的紀錄');
  }
  const accountNames = Object.fromEntries(accounts.map(account => [account.id, account.name]));
  const groupCounts = options.groupCounts || new Map();
  return transactions
    .map(transaction => {
      const isExpense = transaction.type === 'expense';
      const isIncome = transaction.type === 'income';
      const label =
        transaction.type === 'transfer'
          ? `${accountNames[transaction.account] || transaction.account} → ${accountNames[transaction.toAccount] || transaction.toAccount}`
          : [transaction.category, transaction.subcategory].filter(Boolean).join(' · ');
      const transferFee =
        transaction.type === 'transfer' && Number.isInteger(transaction.fee) && transaction.fee > 0
          ? `手續費 ${formatMoney(transaction.fee)}`
          : '';
      const primaryName =
        transaction.name || transaction.note || label || TYPE_LABELS[transaction.type];
      const secondary = [
        groupCounts.get(transaction.groupId) > 1 ? `同段 ${groupCounts.get(transaction.groupId)} 筆` : '',
        transferFee,
        label,
        formatDate(transaction.date),
      ]
        .filter(Boolean)
        .join(' · ');
      const sign = isExpense ? '-' : isIncome ? '+' : '';
      return `
        <article class="transaction-row" data-transaction-row data-type="${transaction.type}">
          <button class="transaction-summary" type="button" data-detail-id="${escapeHtml(transaction.id)}" aria-label="查看 ${escapeHtml(primaryName)} 詳情">
            ${categoryMark(transaction.category || '轉')}
            <span class="transaction-copy">
              <strong>${escapeHtml(primaryName)}</strong>
              <span>${escapeHtml(secondary)}</span>
            </span>
            <span class="transaction-amount ${transaction.type}">
              <strong>${sign}${formatMoney(transaction.amount).replace('NT$ ', '')}</strong>
              <span>${escapeHtml(accountNames[transaction.account] || transaction.account)}</span>
            </span>
          </button>
          <div class="row-actions">
            <button type="button" data-edit-id="${escapeHtml(transaction.id)}" aria-label="編輯 ${escapeHtml(primaryName)}">${icon('edit', 16)}</button>
            <button type="button" data-delete-id="${escapeHtml(transaction.id)}" aria-label="刪除 ${escapeHtml(primaryName)}">${icon('trash', 16)}</button>
          </div>
        </article>`;
    })
    .join('');
}

function groupedTransactions(transactions) {
  const counts = new Map();
  transactions.forEach(transaction => {
    if (!transaction.groupId) return;
    counts.set(transaction.groupId, (counts.get(transaction.groupId) || 0) + 1);
  });
  return counts;
}

function dailyNetByDate(transactions) {
  const result = new Map();
  (transactions || []).forEach(transaction => {
    const date = transaction?.date;
    if (!date) return;
    const current = result.get(date) || { income: 0, expense: 0 };
    const amount = Number(transaction.amount) || 0;
    const next = transaction.type === 'income'
      ? { income: current.income + amount, expense: current.expense }
      : transaction.type === 'expense'
        ? { income: current.income, expense: current.expense + amount }
        : current;
    result.set(date, { ...next, net: next.income - next.expense });
  });
  return result;
}

function formatNetAmount(amount) {
  return `${amount > 0 ? '+' : ''}${formatCompactMoney(amount)}`;
}

function rowsForState(state, transactions) {
  return transactionRows(transactions, state.accounts, {
    groupCounts: groupedTransactions(state.transactions),
  });
}

function categoryBreakdown(summary) {
  const entries = Object.entries(summary.byCategory).toSorted((a, b) => b[1] - a[1]);
  if (!entries.length) return emptyState('本月沒有支出');
  return entries
    .map(([category, amount]) => {
      const width = summary.expense ? Math.max(5, (amount / summary.expense) * 100) : 0;
      return `<div class="category-line">
        ${categoryMark(category)}
        <div><span><strong>${escapeHtml(category)}</strong><small>${Math.round((amount / summary.expense) * 100)}%</small></span><div class="progress-track"><i style="width:${width}%"></i></div></div>
        <strong>${formatCompactMoney(amount)}</strong>
      </div>`;
    })
    .join('');
}

export function renderOverview(state, month) {
  const summary = summarizeMonth(state.transactions, month);
  const monthlyTransactions = filterTransactions(state.transactions, { month });
  const accountBalances = calculateAccountBalances(state.accounts, state.transactions);
  const accountById = Object.fromEntries(accountBalances.map(item => [item.id, item.balance]));
  const totalAssets = calculateTotalAssets(accountBalances);
  const budgetProgress = calculateBudgetProgress(state.budgets, state.transactions, month);
  const totalBudget = budgetProgress.reduce((sum, item) => sum + item.limit, 0);
  const budgetSpent = budgetProgress.reduce((sum, item) => sum + item.spent, 0);
  const budgetRatio = totalBudget ? Math.min(1, budgetSpent / totalBudget) : 0;
  const signals = findTransactionSignals(state.transactions);
  const pendingReviews = state.transactions.filter(transaction => transaction.aiStatus === 'pending').length;
  const attentionCount = new Set([...signals.duplicates.keys(), ...signals.anomalies.keys()]).size;
  const latestReconciliations = (state.featureSettings?.reconciliations || [])
    .toSorted((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .reduce((result, item) => {
      if (!result.has(item.accountId)) result.set(item.accountId, item);
      return result;
    }, new Map());

  return `<section class="view overview-view" aria-labelledby="overview-title">
    <div class="hero-heading">
      <div>
        <p class="eyebrow">${monthLabel(month)} · ${summary.count} 筆收支</p>
        <h1 id="overview-title">總覽</h1>
      </div>
      <div class="month-stepper" aria-label="切換月份">
        <button type="button" data-month-shift="-1" aria-label="上個月">‹</button>
        <strong>${Number(month.slice(5))} 月</strong>
        <button type="button" data-month-shift="1" aria-label="下個月">›</button>
      </div>
    </div>

    <div class="cashflow-card">
      <div class="cashflow-main">
        <span>本月結餘</span>
        <strong class="${summary.balance < 0 ? 'negative' : ''}">${formatMoney(summary.balance, { showPlus: true })}</strong>
      </div>
      <div class="cashflow-rail" aria-label="收入與支出對比">
        <div class="rail-income"><span style="width:${summary.income || summary.expense ? Math.max(6, (summary.income / Math.max(summary.income, summary.expense)) * 100) : 6}%"></span></div>
        <div class="rail-expense"><span style="width:${summary.income || summary.expense ? Math.max(6, (summary.expense / Math.max(summary.income, summary.expense)) * 100) : 6}%"></span></div>
      </div>
      <div class="cashflow-metrics">
        <div><span class="dot income"></span><small>收入</small><strong data-testid="summary-income">${formatMoney(summary.income)}</strong></div>
        <div><span class="dot expense"></span><small>支出</small><strong data-testid="summary-expense">${formatMoney(summary.expense)}</strong></div>
      </div>
    </div>

    <div class="overview-grid">
      <section class="panel accounts-panel">
        <div class="section-heading"><h2>帳戶</h2><span>估算餘額</span></div>
        <div class="asset-total">
          <div><small>所有帳戶目前餘額</small><strong class="${totalAssets < 0 ? 'negative' : ''}" data-testid="total-assets">${formatMoney(totalAssets)}</strong></div>
          <span>總資產</span>
        </div>
        <div class="account-list">
          ${state.accounts
            .map(account => {
              const latest = latestReconciliations.get(account.id);
              const reconciliation = latest
                ? reconciliationStatus(accountById[account.id] || 0, latest.actualBalance)
                : null;
              const note = reconciliation
                ? reconciliation.status === 'matched'
                  ? '已對帳'
                  : `差 ${formatMoney(Math.abs(reconciliation.difference))}`
                : '';
              return `<div class="account-item"><span class="account-glyph">${escapeHtml(account.icon)}</span><div><small>${escapeHtml(account.name)} ${note ? `· ${escapeHtml(note)}` : ''}</small><strong>${formatMoney(accountById[account.id] || 0)}</strong></div></div>`;
            })
            .join('')}
        </div>
      </section>

      <section class="panel budget-glance">
        <div class="section-heading"><h2>預算</h2><button type="button" data-go-view="budgets">設定</button></div>
        <div class="budget-dial-row">
          <div class="budget-dial" style="--progress:${budgetRatio * 360}deg"><span>${Math.round(budgetRatio * 100)}<small>%</small></span></div>
          <div><strong>${totalBudget ? formatMoney(Math.max(0, totalBudget - budgetSpent)) : '尚未設定'}</strong><p>${totalBudget ? `已用 ${formatMoney(budgetSpent)} / ${formatMoney(totalBudget)}` : '設定每月分類上限'}</p></div>
        </div>
      </section>
    </div>

    <div class="overview-grid lower-grid">
      <section class="panel">
        <div class="section-heading"><h2>支出分類</h2><span>${formatMoney(summary.expense)}</span></div>
        <div class="category-breakdown">${categoryBreakdown(summary)}</div>
      </section>
      <section class="panel recent-panel">
        <div class="section-heading"><h2>最近交易</h2><button type="button" data-go-view="history">全部紀錄</button></div>
        <div class="transaction-list compact">${rowsForState(state, monthlyTransactions.slice(0, 5))}</div>
      </section>
    </div>
    <section class="panel operations-panel">
      <div class="section-heading"><h2>待處理</h2><span>點選後開啟紀錄</span></div>
      <div class="operation-actions">
        <button type="button" data-go-view="history" data-history-preset="review">AI 待審 <strong>${pendingReviews}</strong></button>
        <button type="button" data-go-view="history" data-history-preset="attention">需確認 <strong>${attentionCount}</strong></button>
        <button type="button" data-go-view="history" data-history-preset="today">今天 <strong>${state.transactions.filter(item => item.date === todayInTaipei()).length}</strong></button>
      </div>
    </section>
  </section>`;
}

export function renderHistory(state, month, filters) {
  const signals = findTransactionSignals(state.transactions);
  const baseResults = filterTransactions(state.transactions, { month, ...filters });
  const today = todayInTaipei();
  const weekStart = new Date(`${today}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const weekStartText = weekStart.toISOString().slice(0, 10);
  const results = baseResults.filter(transaction => {
    if (filters.preset === 'today') return transaction.date === today;
    if (filters.preset === 'week') return transaction.date >= weekStartText && transaction.date <= today;
    if (filters.preset === 'review') return transaction.aiStatus === 'pending';
    if (filters.preset === 'attention') return signals.duplicates.has(transaction.id) || signals.anomalies.has(transaction.id);
    return true;
  });
  const presetButtons = [
    ['all', '全部'],
    ['today', '今天'],
    ['week', '7 天'],
    ['review', 'AI 待審'],
    ['attention', '需確認'],
  ].map(([value, label]) => `<button type="button" data-history-preset="${value}" aria-pressed="${(filters.preset || 'all') === value}">${label}</button>`).join('');
  const typeButtons = [
    ['', '全部'],
    ...Object.entries(TYPE_LABELS),
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-history-filter="type" data-history-value="${escapeHtml(value)}" aria-pressed="${filters.type === value}">${escapeHtml(label)}</button>`,
    )
    .join('');
  const accountButtons = [
    ['', '全部'],
    ...state.accounts.map(account => [account.id, account.name]),
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-history-filter="account" data-history-value="${escapeHtml(value)}" aria-pressed="${filters.account === value}">${escapeHtml(label)}</button>`,
    )
    .join('');
  const filterStatus = {
    attention: '查看原因後確認無誤',
    review: 'AI 正在背景審查',
    today: '今天的紀錄',
    week: '最近 7 天',
  }[filters.preset] || '以日期由新到舊';
  return `<section class="view history-view" aria-labelledby="history-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="history-title">紀錄</h1></div><div class="month-stepper" aria-label="切換月份"><button type="button" data-month-shift="-1" aria-label="上個月">‹</button><strong>${Number(month.slice(5))} 月</strong><button type="button" data-month-shift="1" aria-label="下個月">›</button></div></div>
    <section class="panel history-panel">
      <div class="filter-bar">
        <label class="search-field"><span class="visually-hidden">搜尋紀錄</span><span aria-hidden="true">⌕</span><input id="history-search" aria-label="搜尋紀錄" type="search" value="${escapeHtml(filters.query)}" placeholder="搜尋備註、分類、帳戶" /></label>
        <div class="history-filter-group history-preset-group" role="group" aria-label="快速篩選"><span>快速篩選</span><div class="filter-chip-scroll">${presetButtons}</div></div>
        <div class="history-filter-group" role="group" aria-label="篩選類型"><span>類型</span><div class="filter-chip-scroll">${typeButtons}</div></div>
        <div class="history-filter-group" role="group" aria-label="篩選帳戶"><span>帳戶</span><div class="filter-chip-scroll">${accountButtons}</div></div>
      </div>
      <div class="history-result-meta"><strong>${results.length} 筆紀錄</strong><span id="history-filter-status">${filterStatus}</span></div>
      <div id="history-list" class="transaction-list">${rowsForState(state, results)}</div>
    </section>
  </section>`;
}

export function renderBudgets(state, month) {
  const progress = calculateBudgetProgress(state.budgets, state.transactions, month);
  return `<section class="view budgets-view" aria-labelledby="budgets-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="budgets-title">預算</h1></div></div>
    <div class="budgets-layout">
      <form id="budget-form" class="panel budget-form">
        <h2>新增預算</h2>
        <label><span>預算分類</span><select name="category" aria-label="預算分類">${EXPENSE_CATEGORIES.map(category => `<option value="${category}">${category}</option>`).join('')}</select></label>
        <label><span>每月上限</span><div class="inline-money"><small>NT$</small><input name="limit" aria-label="每月上限" type="number" min="1" step="1" inputmode="numeric" placeholder="5,000" required /></div></label>
        <button class="primary-button" type="submit">儲存預算</button>
      </form>
      <section class="panel budget-list-panel">
        <div class="section-heading"><h2>預算清單</h2><span>${progress.length} 個分類</span></div>
        <div class="budget-list">${
          progress.length
            ? progress
                .map(item => `<article class="budget-row ${item.status}">
                  ${categoryMark(item.category)}
                  <div class="budget-row-main"><span><strong>${escapeHtml(item.category)}預算</strong><small>${formatMoney(item.spent)} / ${formatMoney(item.limit)}</small></span><div class="progress-track"><i style="width:${Math.min(100, item.ratio * 100)}%"></i></div><p>${item.remaining >= 0 ? `還剩 ${formatMoney(item.remaining)}` : `已超出 ${formatMoney(Math.abs(item.remaining))}`}</p></div>
                  <button type="button" data-remove-budget="${escapeHtml(item.category)}" aria-label="移除 ${escapeHtml(item.category)} 預算">×</button>
                </article>`)
                .join('')
            : emptyState('尚未設定預算')
        }</div>
      </section>
    </div>
  </section>`;
}

function daysInRange(from, to) {
  const result = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end && result.length < 370) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function renderInsights(state, month, options = {}) {
  const today = todayInTaipei();
  const filters = options.insightFilters || { period: 'month', date: '', anchorDate: today };
  const period = ['week', 'month', 'year'].includes(filters.period) ? filters.period : 'month';
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(filters.anchorDate) ? filters.anchorDate : today;
  const workspace = buildAnalysisWorkspace(state.transactions, {
    period,
    selectedMonth: month,
    today: anchorDate,
  });
  const dailyTotalsByDate = dailyNetByDate(workspace.scoped);
  const selectedDate = filters.date >= workspace.range.from && filters.date <= workspace.range.to
    ? filters.date
    : '';
  const selectedTransactions = selectedDate
    ? workspace.scoped.filter(transaction => transaction.date === selectedDate)
    : [];
  const periodTabs = [['week', '本週'], ['month', '本月'], ['year', '本年']]
    .map(([value, label]) => `<button type="button" data-insight-period="${value}" aria-pressed="${period === value}">${label}</button>`)
    .join('');
  const dateButton = (date, className, label) => {
    const daily = dailyTotalsByDate.get(date) || { income: 0, expense: 0, net: 0 };
    const hasActivity = daily.income > 0 || daily.expense > 0;
    const toneClass = daily.net < 0
      ? ' analysis-net-negative'
      : daily.net > 0
        ? ' analysis-net-positive'
        : hasActivity
          ? ' analysis-net-neutral'
          : '';
    const selected = selectedDate === date;
    const todayClass = date === today ? ' analysis-period-today' : '';
    return `<button type="button" class="${className}${toneClass}${selected ? ' analysis-period-selected' : ''}${todayClass}" data-insight-date="${date}" aria-pressed="${selected}" aria-label="${formatDate(date)} 收入 ${formatMoney(daily.income)}，支出 ${formatMoney(daily.expense)}，淨額 ${formatMoney(daily.net, { showPlus: true })}">${label(daily, hasActivity)}</button>`;
  };
  const weekDays = daysInRange(workspace.range.from, workspace.range.to)
    .map((date, index) => {
      return dateButton(date, 'analysis-week-cell', (_daily, hasActivity) => `<span>${['日', '一', '二', '三', '四', '五', '六'][index]}</span><strong>${Number(date.slice(8))}</strong>${hasActivity ? '<i></i>' : ''}`);
    })
    .join('');
  const calendarDates = (() => {
    const first = new Date(`${month}-01T00:00:00Z`);
    const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells = [
      ...Array(first.getUTCDay()).fill(''),
      ...Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`),
    ];
    while (cells.length % 7) cells.push('');
    return cells;
  })();
  const calendarCells = calendarDates
    .map(date => {
      if (!date) return '<span class="analysis-cal-empty" aria-hidden="true"></span>';
      return dateButton(date, 'analysis-cal-cell', (daily, hasActivity) => `<strong>${Number(date.slice(8))}</strong><small>${hasActivity ? formatNetAmount(daily.net) : ''}</small>`);
    })
    .join('');
  const yearMonths = workspace.monthRows
    .map(item => {
      const monthNumber = Number(item.month.slice(5));
      return `<button type="button" class="analysis-year-mo" data-insight-month="${item.month}" aria-label="${monthNumber} 月支出 ${formatMoney(item.amount)}"><span>${monthNumber} 月</span><strong>${item.amount ? formatCompactMoney(item.amount) : '—'}</strong></button>`;
    })
    .join('');
  const periodLabel = period === 'week'
    ? workspace.range.label
    : period === 'month'
      ? monthLabel(month)
      : `${workspace.range.from.slice(0, 4)} 年`;
  const periodContent = period === 'week'
    ? `<div class="analysis-week-strip" role="group" aria-label="本週各日">${weekDays}</div>`
    : period === 'month'
      ? `<div class="analysis-cal-weekdays" aria-hidden="true"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="analysis-cal-grid" role="grid" aria-label="月曆，點選單日">${calendarCells}</div>`
      : `<div class="analysis-year-months" role="group" aria-label="各月支出">${yearMonths}</div>`;
  const categoryColors = ['#236b56', '#d96545', '#c28724', '#71896b', '#7a6b96', '#4d7c9a', '#9b5b76', '#7b7e51'];
  let angle = 0;
  const pieStops = workspace.categoryRows.slice(0, 8).map((item, index) => {
    const start = angle;
    angle += item.percent;
    return `${categoryColors[index]} ${start}% ${angle}%`;
  });
  const pieStyle = pieStops.length ? `background:conic-gradient(${pieStops.join(', ')})` : '';
  const categoryLegend = workspace.categoryRows.length
    ? workspace.categoryRows.slice(0, 8).map((item, index) => `<div class="analysis-legend-row"><i style="background:${categoryColors[index]}"></i>${categoryMark(item.category)}<strong>${escapeHtml(item.category)}</strong><small>${item.percent}%</small><b>${formatCompactMoney(item.amount)}</b></div>`).join('')
    : emptyState('本期沒有支出');
  return `<section class="view insights-view" aria-labelledby="insights-title">
    <h1 id="insights-title" class="visually-hidden">趨勢</h1>
    <section class="daily-analysis-shell">
      <div class="analysis-tabs" role="group" aria-label="分析區間">${periodTabs}</div>
      <div id="trend-chart" class="analysis-period-nav analysis-period-nav--${period}">
        <button type="button" data-insight-shift="-1" aria-label="上一期">‹</button>
        <strong>${periodLabel}</strong>
        <button type="button" data-insight-shift="1" aria-label="下一期">›</button>
        ${periodContent}
      </div>
      <div class="daily-analysis-overview" aria-label="收支摘要">
        <div class="daily-analysis-total"><span>支出</span><strong>${formatMoney(workspace.totals.expense)}</strong><small>${workspace.expenseTransactions.length} 筆</small></div>
        <div class="daily-analysis-metrics"><div><span>收入</span><strong>${formatMoney(workspace.totals.income)}</strong></div><div><span>結餘</span><strong class="${workspace.totals.income - workspace.totals.expense < 0 ? 'negative' : workspace.totals.income - workspace.totals.expense > 0 ? 'positive' : ''}">${formatMoney(workspace.totals.income - workspace.totals.expense, { showPlus: true })}</strong></div></div>
      </div>
      <section class="daily-analysis-insights" aria-label="分析重點">
        <div class="daily-analysis-section-head"><strong>分析重點</strong><small>${periodLabel}</small></div>
        <div class="daily-analysis-insight-list">${workspace.insights.map(item => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('')}</div>
      </section>
      <section class="daily-analysis-breakdown" aria-label="分類支出">
        <div class="daily-analysis-section-head"><strong>分類支出</strong><small>${formatMoney(workspace.totals.expense)}</small></div>
        <div class="daily-analysis-breakdown-body"><div class="analysis-donut" style="${pieStyle}"><div><span>支出</span><strong>${formatCompactMoney(workspace.totals.expense)}</strong></div></div><div class="daily-analysis-legend">${categoryLegend}</div></div>
      </section>
      ${selectedDate ? `<section class="analysis-history-section"><div class="analysis-history-head"><div><strong>${escapeHtml(formatDate(selectedDate))}</strong><span>當日明細</span></div><button type="button" data-insight-date="">顯示整段</button></div><div class="transaction-list compact">${rowsForState(state, selectedTransactions)}</div></section>` : ''}
    </section>
  </section>`;
}

export function renderView(view, state, month, filters, options = {}) {
  if (view === 'history') return renderHistory(state, month, filters);
  if (view === 'budgets') return renderBudgets(state, month);
  if (view === 'insights') return renderInsights(state, month, options);
  return renderOverview(state, month);
}
