import { CATEGORY_TONES, EXPENSE_CATEGORIES, TYPE_LABELS } from './config.js';
import {
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateTotalAssets,
  expenseAmount,
  summarizeMonth,
} from './domain/insights.js';
import { filterTransactions } from './domain/transactions.js';
import { findTransactionSignals, reconciliationStatus } from './domain/ledger-enhancements.js';
import { buildAnalysisWorkspace } from './domain/analysis-workspace.js';
import {
  investmentDirection,
  isInvestmentTransfer,
  summarizeInvestmentFlows,
} from './domain/investment-accounting.js';
import { escapeHtml, formatCompactMoney, formatDate, formatMoney, monthLabel, todayInTaipei } from './format.js';
import { icon } from './icons.js';

function emptyState(title, body = '') {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><strong>${title}</strong>${body ? `<p>${body}</p>` : ''}</div>`;
}

function categoryMark(category) {
  const tone = CATEGORY_TONES[category] || 'slate';
  const symbols = {
    '飲食': '◒', '交通': '⇆', '居家': '⌂', '購物': '◇', '娛樂': '▷', '醫療': '+',
    '學習': '▤', '帳單': '≡', '投資': '↗', '人情': '♡', '寵物': '●', '其他': '…',
    '薪資': '$', '獎金': '★', '接案': '◈', '租賃': '⌂', '退款與理賠': '↩', '補助': '+',
    '零用與贈與': '♡', '禮金': '♡', '銷售': '◇', '中獎': '★', '其他收入': '…', '轉': '⇆',
  };
  return `<span class="category-mark tone-${tone}" aria-hidden="true">${escapeHtml(symbols[category] || category?.slice(0, 1) || '其')}</span>`;
}

function transactionTime(transaction) {
  if (!transaction?.createdAt) return '';
  const date = new Date(transaction.createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
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
        isInvestmentTransfer(transaction)
          ? ['投資', transaction.subcategory].filter(Boolean).join(' · ')
          : transaction.type === 'transfer'
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
        isInvestmentTransfer(transaction)
          ? `${accountNames[transaction.account] || transaction.account} → ${accountNames[transaction.toAccount] || transaction.toAccount}`
          : '',
        options.showTime ? transactionTime(transaction) : '',
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
              <span>${isInvestmentTransfer(transaction) ? (investmentDirection(transaction) === 'contributed' ? '投入' : '領回') : escapeHtml(accountNames[transaction.account] || transaction.account)}</span>
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
      : { income: current.income, expense: current.expense + expenseAmount(transaction) };
    result.set(date, { ...next, net: next.income - next.expense });
  });
  return result;
}

function formatNetAmount(amount) {
  return `${amount > 0 ? '+' : ''}${formatCompactMoney(amount)}`;
}

function rowsForState(state, transactions, options = {}) {
  return transactionRows(transactions, state.accounts, {
    groupCounts: groupedTransactions(state.transactions),
    ...options,
  });
}

function expenseDisplayTransactions(transactions) {
  return transactions.map(row => row.type === 'transfer'
    ? {
        ...row,
        type: 'expense',
        amount: expenseAmount(row),
        category: '帳單',
        subcategory: '轉帳手續費',
        name: `${row.name || '轉帳'}（手續費）`,
      }
    : row);
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
  const investment = summarizeInvestmentFlows(monthlyTransactions);
  const accountBalances = calculateAccountBalances(state.accounts, state.transactions);
  const accountById = Object.fromEntries(accountBalances.map(item => [item.id, item.balance]));
  const totalAssets = calculateTotalAssets(accountBalances);
  const budgetProgress = calculateBudgetProgress(state.budgets, state.transactions, month);
  const totalBudget = budgetProgress.reduce((sum, item) => sum + item.limit, 0);
  const budgetSpent = budgetProgress.reduce((sum, item) => sum + item.spent, 0);
  const budgetRatio = totalBudget ? Math.min(1, budgetSpent / totalBudget) : 0;
  const overviewToday = todayInTaipei();
  const overviewMonthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const overviewDaysLeft = overviewToday.slice(0, 7) === month
    ? Math.max(1, overviewMonthEnd - Number(overviewToday.slice(8)) + 1)
    : overviewMonthEnd;
  const dailyBudgetAllowance = totalBudget ? Math.floor(Math.max(0, totalBudget - budgetSpent) / overviewDaysLeft) : 0;
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
        <span>生活結餘</span>
        <strong class="${summary.balance < 0 ? 'negative' : ''}">${formatMoney(summary.balance, { showPlus: true })}</strong>
      </div>
      <div class="cashflow-rail" aria-label="收入與支出對比">
        <div class="rail-income"><span style="width:${summary.income || summary.expense ? Math.max(6, (summary.income / Math.max(summary.income, summary.expense)) * 100) : 6}%"></span></div>
        <div class="rail-expense"><span style="width:${summary.income || summary.expense ? Math.max(6, (summary.expense / Math.max(summary.income, summary.expense)) * 100) : 6}%"></span></div>
      </div>
      <div class="cashflow-metrics cashflow-metrics--investment">
        <div><span class="dot income"></span><small>收入</small><strong data-testid="summary-income">${formatMoney(summary.income)}</strong></div>
        <div><span class="dot expense"></span><small>生活支出</small><strong data-testid="summary-expense">${formatMoney(summary.expense)}</strong></div>
        <div><span class="dot investment"></span><small>投資投入</small><strong data-testid="summary-investment-in">${formatMoney(investment.contributed)}</strong></div>
        <div><span class="dot withdrawal"></span><small>投資領回</small><strong data-testid="summary-investment-out">${formatMoney(investment.withdrawn)}</strong></div>
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
          <div><strong>${totalBudget ? formatMoney(Math.max(0, totalBudget - budgetSpent)) : '尚未設定'}</strong><p>${totalBudget ? `已用 ${formatMoney(budgetSpent)} / ${formatMoney(totalBudget)}` : '設定每月分類上限'}</p>${totalBudget ? `<small class="budget-daily-limit">每天還能用 ${formatMoney(dailyBudgetAllowance)}</small>` : ''}</div>
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
  const today = todayInTaipei();
  const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const isCurrentMonth = today.slice(0, 7) === month;
  const daysLeft = isCurrentMonth ? Math.max(1, monthEnd - Number(today.slice(8)) + 1) : monthEnd;
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
                  <div class="budget-row-main"><span><strong>${escapeHtml(item.category)}預算</strong><small>${formatMoney(item.spent)} / ${formatMoney(item.limit)}</small></span><div class="progress-track"><i style="width:${Math.min(100, item.ratio * 100)}%"></i></div><p>${item.remaining >= 0 ? `還剩 ${formatMoney(item.remaining)}` : `已超出 ${formatMoney(Math.abs(item.remaining))}`}</p><small class="budget-daily-limit">${item.remaining >= 0 ? `每天還能用 ${formatMoney(Math.floor(item.remaining / daysLeft))}` : `每天需少用 ${formatMoney(Math.ceil(Math.abs(item.remaining) / daysLeft))}`} · ${isCurrentMonth ? `剩 ${daysLeft} 天` : '按整月計算'}</small></div>
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

function changeLabel(value) {
  if (value == null) return '無前期資料';
  if (value === 0) return '與前期相同';
  return `較前期 ${value > 0 ? '+' : ''}${value}%`;
}

function analysisTimeBars(rows, label) {
  const max = Math.max(1, ...rows.map(row => row.amount));
  return `<div class="analysis-time-bars" role="img" aria-label="${escapeHtml(label)}">${rows.map(row => {
    const height = row.amount ? Math.max(5, Math.round(row.amount / max * 100)) : 0;
    return `<div class="analysis-time-bar" title="${escapeHtml(row.label)} ${formatMoney(row.amount)}"><span><b>${row.amount ? formatCompactMoney(row.amount) : ''}</b><i style="height:${height}%"></i></span><small>${escapeHtml(row.label)}</small></div>`;
  }).join('')}</div>`;
}

function rankedBarRows(groups, options) {
  const max = Math.max(1, ...groups.map(group => group.amount));
  const accountNames = options.accountNames || {};
  return groups.map(group => {
    const key = group[options.key];
    const label = options.key === 'account' ? accountNames[key] || key : key;
    const width = Math.max(3, Math.round(group.amount / max * 100));
    const selected = options.selected === key;
    const attribute = options.attribute ? `${options.attribute}="${escapeHtml(key)}"` : '';
    const tag = options.attribute ? 'button' : 'div';
    return `<${tag} class="analysis-ranked-row${selected ? ' is-selected' : ''}" ${attribute}${options.attribute ? ` aria-pressed="${selected}"` : ''}>
      ${options.showMark ? categoryMark(key) : ''}
      <span class="analysis-ranked-copy"><span><strong>${escapeHtml(label)}</strong><small>${group.count} 筆 · ${group.percent}%</small></span><i><b style="width:${width}%"></b></i></span>
      <span class="analysis-ranked-value"><strong>${formatMoney(group.amount)}</strong>${options.showPrevious ? `<small>${changeLabel(group.changePercent)}</small>` : ''}</span>
    </${tag}>`;
  }).join('');
}

function analysisMetricStrip(items, label) {
  return `<div class="analysis-metric-strip" aria-label="${escapeHtml(label)}">${items.map(item => `<div><span>${escapeHtml(item.label)}</span><strong class="${item.tone || ''}">${item.value}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</div>`).join('')}</div>`;
}

function renderSelectedDay(state, selectedDay) {
  if (!selectedDay) return '';
  const flow = selectedDay.investmentFlows;
  return `<section class="analysis-history-section" aria-label="${escapeHtml(formatDate(selectedDay.date))}當日明細">
    <div class="analysis-history-head"><div><strong>${escapeHtml(formatDate(selectedDay.date))}</strong><span>當日明細</span></div><button type="button" data-insight-date="" aria-label="關閉當日明細">關閉</button></div>
    ${analysisMetricStrip([
      { label: '收入', value: formatMoney(selectedDay.totals.income), tone: 'positive' },
      { label: '生活支出', value: formatMoney(selectedDay.totals.expense), tone: 'negative' },
      { label: '生活結餘', value: formatMoney(selectedDay.balance, { showPlus: true }), tone: selectedDay.balance < 0 ? 'negative' : 'positive' },
      { label: '投資投入', value: formatMoney(flow.contributed) },
      { label: '投資領回', value: formatMoney(flow.withdrawn) },
    ], '當日收支摘要')}
    <div class="transaction-list compact">${rowsForState(state, selectedDay.transactions, { showTime: true })}</div>
  </section>`;
}

function renderOverviewAnalysis(workspace, periodLabel) {
  const currentMax = Math.max(1, workspace.totals.income, workspace.totals.expense, Math.abs(workspace.balance));
  const previousMax = Math.max(1, workspace.previousTotals.income, workspace.previousTotals.expense, Math.abs(workspace.comparison.balance));
  const scale = Math.max(currentMax, previousMax);
  const comparisonRows = [
    ['收入', workspace.totals.income, workspace.previousTotals.income, 'income'],
    ['生活支出', workspace.totals.expense, workspace.previousTotals.expense, 'expense'],
    ['生活結餘', workspace.balance, workspace.comparison.balance, 'balance'],
  ];
  return `<section class="analysis-section-panel" aria-label="總覽分析">
    ${analysisMetricStrip([
      { label: '收入', value: formatMoney(workspace.totals.income) },
      { label: '生活支出', value: formatMoney(workspace.totals.expense) },
      { label: '生活結餘', value: formatMoney(workspace.balance, { showPlus: true }), tone: workspace.balance < 0 ? 'negative' : 'positive' },
      { label: '儲蓄率', value: workspace.savingsRate == null ? '—' : `${workspace.savingsRate}%` },
    ], `${periodLabel}總覽`)}
    <div class="analysis-block-head"><div><strong>本期與前期</strong><small>相同經過天數</small></div></div>
    <div class="analysis-comparison-bars">${comparisonRows.map(([label, current, previous, tone]) => `<div class="analysis-comparison-row">
      <strong>${label}</strong><div><span>本期</span><i><b class="${tone}" style="width:${Math.round(Math.abs(current) / scale * 100)}%"></b></i><em>${formatMoney(current, { showPlus: label === '生活結餘' })}</em></div>
      <div><span>前期</span><i><b class="previous" style="width:${Math.round(Math.abs(previous) / scale * 100)}%"></b></i><em>${formatMoney(previous, { showPlus: label === '生活結餘' })}</em></div>
    </div>`).join('')}</div>
  </section>`;
}

function renderFocusAnalysis(state, workspace, type, accountNames) {
  const focus = workspace.focus;
  if (!focus) return '';
  const title = focus.subcategory || focus.category;
  const childRegion = `<div class="analysis-focus-block" role="region" aria-label="${escapeHtml(focus.category)}小分類圖表">
    <div class="analysis-block-head"><div><strong>小分類</strong><small>占大分類比例</small></div></div>
    <div class="analysis-ranked-bars">${rankedBarRows(focus.children, {
      key: 'subcategory', attribute: 'data-insight-subcategory', selected: focus.subcategory,
    })}</div>
  </div>`;
  return `<div class="analysis-focus">
    <div class="analysis-focus-title"><button type="button" data-insight-category="" aria-label="返回全部大分類">‹</button><div><small>${escapeHtml(focus.category)}${focus.subcategory ? ' · 小分類' : ''}</small><strong>${escapeHtml(title)}</strong></div></div>
    ${analysisMetricStrip([
      { label: '金額', value: formatMoney(focus.amount) },
      { label: focus.subcategory ? `占${focus.category}` : `占${type === 'expense' ? '總支出' : '總收入'}`, value: `${focus.percent}%` },
      { label: '筆數', value: `${focus.count} 筆` },
      { label: '平均每筆', value: formatMoney(focus.average), detail: changeLabel(focus.changePercent) },
    ], `${title}數據`)}
    <div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>${escapeHtml(title)}趨勢</strong><small>${type === 'expense' ? '生活支出' : '收入'}</small></div></div>${analysisTimeBars(focus.timeSeries, `${title}期間趨勢`)}</div>
    ${childRegion}
    <div class="analysis-focus-block analysis-account-bars"><div class="analysis-block-head"><div><strong>${type === 'expense' ? '付款' : '入帳'}帳戶</strong></div></div>
      <div class="analysis-ranked-bars">${rankedBarRows(focus.accounts, { key: 'account', accountNames })}</div>
    </div>
    ${focus.subcategory ? `<div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>${escapeHtml(title)}明細</strong><small>${focus.count} 筆</small></div></div><div class="transaction-list compact">${rowsForState(state, type === 'expense' ? expenseDisplayTransactions(focus.transactions) : focus.transactions)}</div></div>` : ''}
  </div>`;
}

function renderCategoryAnalysis(state, workspace, type, filters, accountNames, budgetProgress) {
  const label = type === 'expense' ? '支出' : '收入';
  const groups = type === 'expense' ? workspace.expenseGroups : workspace.incomeGroups;
  const noFocus = filters.category && !workspace.focus
    ? emptyState(`這個期間沒有「${escapeHtml(filters.category)}」資料`)
    : '';
  const budget = type === 'expense' && budgetProgress?.length
    ? `<div class="analysis-focus-block analysis-budget-bars"><div class="analysis-block-head"><div><strong>本月預算</strong><small>僅計生活支出</small></div></div><div class="analysis-ranked-bars">${budgetProgress.map(item => `<div class="analysis-ranked-row"><span class="analysis-ranked-copy"><span><strong>${escapeHtml(item.category)}</strong><small>${Math.round(item.ratio * 100)}%</small></span><i><b class="${item.ratio > 1 ? 'over' : ''}" style="width:${Math.min(100, Math.round(item.ratio * 100))}%"></b></i></span><span class="analysis-ranked-value"><strong>${formatMoney(item.spent)}</strong><small>/ ${formatMoney(item.limit)}</small></span></div>`).join('')}</div></div>`
    : '';
  return `<section class="analysis-section-panel" aria-label="${label}大分類排行">
    <div class="analysis-block-head"><div><strong>${label}大分類</strong><small>點選分類查看小分類</small></div><b>${formatMoney(workspace.totals[type])}</b></div>
    <div class="analysis-ranked-bars">${groups.length ? rankedBarRows(groups, {
      key: 'category', attribute: 'data-insight-category', selected: filters.category, showMark: true, showPrevious: true,
    }) : emptyState(`本期沒有${label}`)}</div>
    ${noFocus || renderFocusAnalysis(state, workspace, type, accountNames)}
    ${budget}
  </section>`;
}

function renderInvestmentAnalysis(state, workspace, investmentAsset) {
  const maxFlow = Math.max(1, ...workspace.investmentGroups.flatMap(group => [group.contributed, group.withdrawn]));
  const maxSeries = Math.max(1, ...workspace.investmentSeries.flatMap(row => [row.contributed, row.withdrawn]));
  const costGroups = Object.values(workspace.investmentCostTransactions.reduce((result, row) => {
    const name = row.type === 'transfer' ? '交易手續費' : row.subcategory || '其他投資支出';
    const current = result[name] || { subcategory: name, amount: 0, count: 0, percent: 0 };
    return { ...result, [name]: { ...current, amount: current.amount + expenseAmount(row), count: current.count + 1 } };
  }, {})).map(group => ({ ...group, percent: workspace.investmentCost ? Math.round(group.amount / workspace.investmentCost * 100) : 0 }))
    .toSorted((left, right) => right.amount - left.amount);
  return `<section class="analysis-section-panel investment-analysis" aria-label="投資分析">
    ${analysisMetricStrip([
      { label: '目前投資資產', value: formatMoney(investmentAsset) },
      { label: '本期投入', value: formatMoney(workspace.investmentFlows.contributed) },
      { label: '本期領回', value: formatMoney(workspace.investmentFlows.withdrawn) },
      { label: '淨投入', value: formatMoney(workspace.investmentFlows.net, { showPlus: true }) },
    ], '投資摘要')}
    <div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>投資流向</strong><small>投入／領回</small></div></div>
      <div class="analysis-investment-series">${workspace.investmentSeries.map(row => `<div title="${escapeHtml(row.label)} 投入 ${formatMoney(row.contributed)}，領回 ${formatMoney(row.withdrawn)}"><span><i class="in" style="height:${Math.round(row.contributed / maxSeries * 100)}%"></i><i class="out" style="height:${Math.round(row.withdrawn / maxSeries * 100)}%"></i></span><small>${escapeHtml(row.label)}</small></div>`).join('')}</div>
    </div>
    <div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>資產細分類</strong><small>投入與領回分開顯示</small></div></div><div class="investment-flow-list">${workspace.investmentGroups.length ? workspace.investmentGroups.map(group => `<div class="investment-flow-row"><div><strong>${escapeHtml(group.subcategory)}</strong><small>${group.count} 筆</small></div><span>投入 ${formatMoney(group.contributed)}</span><span>領回 ${formatMoney(group.withdrawn)}</span><b>${formatMoney(group.net, { showPlus: true })}</b><div class="investment-split-bar"><i class="in" style="width:${Math.round(group.contributed / maxFlow * 100)}%"></i><i class="out" style="width:${Math.round(group.withdrawn / maxFlow * 100)}%"></i></div></div>`).join('') : emptyState('本期沒有投資流向')}</div></div>
    <div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>投資收入</strong><small>股息、配息與利息</small></div><b>${formatMoney(workspace.investmentIncome?.amount || 0)}</b></div><div class="analysis-ranked-bars">${workspace.investmentIncome?.children?.length ? rankedBarRows(workspace.investmentIncome.children, { key: 'subcategory' }) : emptyState('本期沒有投資收入')}</div></div>
    <div class="analysis-focus-block"><div class="analysis-block-head"><div><strong>投資相關支出</strong><small>手續費、稅與工具課程</small></div><b>${formatMoney(workspace.investmentCost)}</b></div><div class="analysis-ranked-bars">${costGroups.length ? rankedBarRows(costGroups, { key: 'subcategory' }) : emptyState('本期沒有投資相關支出')}</div></div>
    ${workspace.investmentCostTransactions.length ? `<div class="transaction-list compact">${rowsForState(state, expenseDisplayTransactions(workspace.investmentCostTransactions))}</div>` : ''}
  </section>`;
}

export function renderInsights(state, month, options = {}) {
  const today = todayInTaipei();
  const rawFilters = options.insightFilters || {};
  const filters = {
    period: rawFilters.period || 'month',
    section: ['overview', 'expense', 'income', 'investment'].includes(rawFilters.section) ? rawFilters.section : 'overview',
    category: rawFilters.category || '',
    subcategory: rawFilters.subcategory || '',
    selectedDate: rawFilters.selectedDate ?? rawFilters.date ?? '',
    anchorDate: rawFilters.anchorDate || today,
  };
  const period = ['week', 'month', 'year'].includes(filters.period) ? filters.period : 'month';
  const anchorDate = /^\d{4}-\d{2}-\d{2}$/.test(filters.anchorDate) ? filters.anchorDate : today;
  const workspace = buildAnalysisWorkspace(state.transactions, {
    period,
    selectedMonth: month,
    today: anchorDate,
    currentDate: today,
    selectedDate: filters.selectedDate,
    section: filters.section,
    category: filters.category,
    subcategory: filters.subcategory,
  });
  const dailyTotalsByDate = dailyNetByDate(workspace.scoped);
  const maxDailyNet = Math.max(1, ...[...dailyTotalsByDate.values()].map(item => Math.abs(item.net)));
  const selectedDate = workspace.selectedDay?.date || '';
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
    const heatClass = hasActivity && daily.net !== 0
      ? ` analysis-heat-${Math.max(1, Math.ceil(Math.abs(daily.net) / maxDailyNet * 5))}`
      : '';
    const selected = selectedDate === date;
    const todayClass = date === today ? ' analysis-period-today' : '';
    return `<button type="button" class="${className}${toneClass}${heatClass}${selected ? ' analysis-period-selected' : ''}${todayClass}" data-insight-date="${date}" aria-pressed="${selected}" aria-label="${formatDate(date)} 收入 ${formatMoney(daily.income)}，支出 ${formatMoney(daily.expense)}，淨額 ${formatMoney(daily.net, { showPlus: true })}">${label(daily, hasActivity)}</button>`;
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
  const maxYearNet = Math.max(1, ...workspace.monthRows.map(item => Math.abs(item.net)));
  const yearMonths = workspace.monthRows
    .map(item => {
      const monthNumber = Number(item.month.slice(5));
      const tone = item.net < 0 ? 'analysis-net-negative' : item.net > 0 ? 'analysis-net-positive' : '';
      const heat = item.net ? `analysis-heat-${Math.max(1, Math.ceil(Math.abs(item.net) / maxYearNet * 5))}` : '';
      return `<button type="button" class="analysis-year-mo ${tone} ${heat}" data-insight-month="${item.month}" aria-label="${monthNumber} 月收入 ${formatMoney(item.income)}，支出 ${formatMoney(item.amount)}，淨額 ${formatMoney(item.net, { showPlus: true })}"><span>${monthNumber} 月</span><strong>${item.net ? formatNetAmount(item.net) : '—'}</strong></button>`;
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
  const accountNames = Object.fromEntries((state.accounts || []).map(account => [account.id, account.name]));
  const investmentAsset = calculateAccountBalances(state.accounts || [], state.transactions || [])
    .find(account => account.id === 'investment')?.balance || 0;
  const currentBudgetProgress = period === 'month' && month === today.slice(0, 7)
    ? calculateBudgetProgress(state.budgets || [], state.transactions || [], month)
    : [];
  const sectionTabs = [
    ['overview', '總覽'], ['expense', '支出'], ['income', '收入'], ['investment', '投資'],
  ].map(([value, label]) => `<button type="button" data-insight-section="${value}" aria-label="${label}分析" aria-pressed="${filters.section === value}">${label}</button>`).join('');
  const sectionContent = filters.section === 'expense'
    ? renderCategoryAnalysis(state, workspace, 'expense', filters, accountNames, currentBudgetProgress)
    : filters.section === 'income'
      ? renderCategoryAnalysis(state, workspace, 'income', filters, accountNames, [])
      : filters.section === 'investment'
        ? renderInvestmentAnalysis(state, workspace, investmentAsset)
        : renderOverviewAnalysis(workspace, periodLabel);
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
      ${renderSelectedDay(state, workspace.selectedDay)}
      <div class="analysis-section-tabs" role="tablist" aria-label="分析類型">${sectionTabs}</div>
      ${sectionContent}
    </section>
  </section>`;
}

export function renderView(view, state, month, filters, options = {}) {
  if (view === 'history') return renderHistory(state, month, filters);
  if (view === 'budgets') return renderBudgets(state, month);
  if (view === 'insights') return renderInsights(state, month, options);
  return renderOverview(state, month);
}
