import { CATEGORY_TONES, EXPENSE_CATEGORIES, TYPE_LABELS } from './config.js';
import {
  buildMonthlyTrend,
  calculateAccountBalances,
  calculateBudgetProgress,
  calculateTotalAssets,
  summarizeMonth,
} from './domain/insights.js';
import { filterTransactions } from './domain/transactions.js';
import { escapeHtml, formatCompactMoney, formatDate, formatMoney, monthLabel, shortMonthLabel } from './format.js';
import { icon } from './icons.js';

function emptyState(title, body = '') {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><strong>${title}</strong>${body ? `<p>${body}</p>` : ''}</div>`;
}

function categoryMark(category) {
  const tone = CATEGORY_TONES[category] || 'slate';
  return `<span class="category-mark tone-${tone}" aria-hidden="true">${escapeHtml(category?.slice(0, 1) || '其')}</span>`;
}

export function transactionRows(transactions, accounts) {
  if (!transactions.length) {
    return emptyState('沒有符合的紀錄');
  }
  const accountNames = Object.fromEntries(accounts.map(account => [account.id, account.name]));
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
        transferFee,
        label,
        formatDate(transaction.date),
      ]
        .filter(Boolean)
        .join(' · ');
      const sign = isExpense ? '-' : isIncome ? '+' : '';
      return `
        <article class="transaction-row" data-transaction-row data-type="${transaction.type}">
          ${categoryMark(transaction.category || '轉')}
          <div class="transaction-copy">
            <strong>${escapeHtml(primaryName)}</strong>
            <span>${escapeHtml(secondary)}</span>
          </div>
          <div class="transaction-amount ${transaction.type}">
            <strong>${sign}${formatMoney(transaction.amount).replace('NT$ ', '')}</strong>
            <span>${escapeHtml(accountNames[transaction.account] || transaction.account)}</span>
          </div>
          <div class="row-actions">
            <button type="button" data-edit-id="${escapeHtml(transaction.id)}" aria-label="編輯 ${escapeHtml(primaryName)}">${icon('edit', 16)}</button>
            <button type="button" data-delete-id="${escapeHtml(transaction.id)}" aria-label="刪除 ${escapeHtml(primaryName)}">${icon('trash', 16)}</button>
          </div>
        </article>`;
    })
    .join('');
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
        <div><span class="dot balance"></span><small>平均每筆</small><strong>${formatMoney(summary.count ? Math.round((summary.income + summary.expense) / summary.count) : 0)}</strong></div>
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
            .map(
              account => `<div class="account-item"><span class="account-glyph">${escapeHtml(account.icon)}</span><div><small>${escapeHtml(account.name)}</small><strong>${formatMoney(accountById[account.id] || 0)}</strong></div></div>`,
            )
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
        <div class="transaction-list compact">${transactionRows(monthlyTransactions.slice(0, 5), state.accounts)}</div>
      </section>
    </div>
  </section>`;
}

export function renderHistory(state, month, filters) {
  const results = filterTransactions(state.transactions, { month, ...filters });
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
  return `<section class="view history-view" aria-labelledby="history-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="history-title">紀錄</h1></div></div>
    <section class="panel history-panel">
      <div class="filter-bar">
        <label class="search-field"><span class="visually-hidden">搜尋紀錄</span><span aria-hidden="true">⌕</span><input id="history-search" aria-label="搜尋紀錄" type="search" value="${escapeHtml(filters.query)}" placeholder="搜尋備註、分類、帳戶" /></label>
        <div class="history-filter-group" role="group" aria-label="篩選類型"><span>類型</span><div class="filter-chip-scroll">${typeButtons}</div></div>
        <div class="history-filter-group" role="group" aria-label="篩選帳戶"><span>帳戶</span><div class="filter-chip-scroll">${accountButtons}</div></div>
      </div>
      <div class="history-result-meta"><strong>${results.length} 筆紀錄</strong><span>以日期由新到舊</span></div>
      <div id="history-list" class="transaction-list">${transactionRows(results, state.accounts)}</div>
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

export function renderInsights(state, month) {
  const trend = buildMonthlyTrend(state.transactions, month, 6);
  const summary = summarizeMonth(state.transactions, month);
  const maxAmount = Math.max(1, ...trend.flatMap(item => [item.income, item.expense]));
  const topCategory = Object.entries(summary.byCategory).toSorted((a, b) => b[1] - a[1])[0];
  return `<section class="view insights-view" aria-labelledby="insights-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="insights-title">趨勢</h1></div></div>
    <section class="panel trend-panel">
      <div class="chart-legend"><span><i class="income"></i>收入</span><span><i class="expense"></i>支出</span></div>
      <div id="trend-chart" class="trend-chart" role="img" aria-label="最近六個月收入與支出柱狀圖">
        ${trend
          .map(item => `<div class="trend-column"><div class="trend-bars"><i class="income" style="height:${Math.max(2, (item.income / maxAmount) * 100)}%" title="${shortMonthLabel(item.month)}收入 ${formatMoney(item.income)}"></i><i class="expense" style="height:${Math.max(2, (item.expense / maxAmount) * 100)}%" title="${shortMonthLabel(item.month)}支出 ${formatMoney(item.expense)}"></i></div><span>${shortMonthLabel(item.month)}</span></div>`)
          .join('')}
      </div>
    </section>
    <div class="insight-cards">
      <article class="insight-card coral"><p class="eyebrow">最大支出分類</p><strong>${topCategory ? topCategory[0] : '尚無資料'}</strong><p>${topCategory ? `${formatMoney(topCategory[1])} · ${Math.round((topCategory[1] / summary.expense) * 100)}%` : ''}</p></article>
      <article class="insight-card blue"><p class="eyebrow">本月結餘</p><strong>${formatMoney(summary.balance, { showPlus: true })}</strong><p>${formatMoney(summary.income)} 收入 · ${formatMoney(summary.expense)} 支出</p></article>
      <article class="insight-card olive"><p class="eyebrow">交易筆數</p><strong>${summary.count} 筆</strong><p>${summary.count ? `平均 ${formatMoney(Math.round((summary.income + summary.expense) / summary.count))}` : ''}</p></article>
    </div>
  </section>`;
}

export function renderView(view, state, month, filters) {
  if (view === 'history') return renderHistory(state, month, filters);
  if (view === 'budgets') return renderBudgets(state, month);
  if (view === 'insights') return renderInsights(state, month);
  return renderOverview(state, month);
}
