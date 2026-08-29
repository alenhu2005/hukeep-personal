import { CATEGORY_TONES, EXPENSE_CATEGORIES, TYPE_LABELS } from './config.js';
import {
  buildMonthlyTrend,
  calculateAccountBalances,
  calculateBudgetProgress,
  summarizeMonth,
} from './domain/insights.js';
import { filterTransactions } from './domain/transactions.js';
import { escapeHtml, formatCompactMoney, formatDate, formatMoney, monthLabel, shortMonthLabel } from './format.js';
import { icon } from './icons.js';

function emptyState(title, body) {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><strong>${title}</strong><p>${body}</p></div>`;
}

function categoryMark(category) {
  const tone = CATEGORY_TONES[category] || 'slate';
  return `<span class="category-mark tone-${tone}" aria-hidden="true">${escapeHtml(category?.slice(0, 1) || '其')}</span>`;
}

export function transactionRows(transactions, accounts) {
  if (!transactions.length) {
    return emptyState('還沒有符合的紀錄', '新增第一筆，這裡就會開始長出你的財務脈絡。');
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
      const primaryName =
        transaction.name || transaction.note || label || TYPE_LABELS[transaction.type];
      const secondary = [
        transaction.note && transaction.note !== primaryName ? transaction.note : '',
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
  if (!entries.length) return emptyState('還沒有支出', '這個月的分類流向會顯示在這裡。');
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
  const budgetProgress = calculateBudgetProgress(state.budgets, state.transactions, month);
  const totalBudget = budgetProgress.reduce((sum, item) => sum + item.limit, 0);
  const budgetSpent = budgetProgress.reduce((sum, item) => sum + item.spent, 0);
  const budgetRatio = totalBudget ? Math.min(1, budgetSpent / totalBudget) : 0;

  return `<section class="view overview-view" aria-labelledby="overview-title">
    <div class="hero-heading">
      <div>
        <p class="eyebrow">${monthLabel(month)} · ${summary.count} 筆收支</p>
        <h1 id="overview-title"><span>這個月，</span><span>把錢用在哪裡？</span></h1>
        <p>先看流向，再決定下一筆錢要去哪裡。</p>
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
        <small>${summary.balance >= 0 ? '收入還有空間，慢慢來。' : '這個月支出已超過收入。'}</small>
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
        <div class="section-heading"><div><p class="eyebrow">位置</p><h2>我的帳戶</h2></div><span>估算餘額</span></div>
        <div class="account-list">
          ${state.accounts
            .map(
              account => `<div class="account-item"><span class="account-glyph">${escapeHtml(account.icon)}</span><div><small>${escapeHtml(account.name)}</small><strong>${formatMoney(accountById[account.id] || 0)}</strong></div></div>`,
            )
            .join('')}
        </div>
      </section>

      <section class="panel budget-glance">
        <div class="section-heading"><div><p class="eyebrow">邊界</p><h2>預算進度</h2></div><button type="button" data-go-view="budgets">設定</button></div>
        <div class="budget-dial-row">
          <div class="budget-dial" style="--progress:${budgetRatio * 360}deg"><span>${Math.round(budgetRatio * 100)}<small>%</small></span></div>
          <div><strong>${totalBudget ? formatMoney(Math.max(0, totalBudget - budgetSpent)) : '還沒設定'}</strong><p>${totalBudget ? `本月還能自在安排，總上限 ${formatMoney(totalBudget)}。` : '加入常用分類的每月上限。'}</p></div>
        </div>
      </section>
    </div>

    <div class="overview-grid lower-grid">
      <section class="panel">
        <div class="section-heading"><div><p class="eyebrow">分布</p><h2>支出都去了哪裡</h2></div><span>${formatMoney(summary.expense)}</span></div>
        <div class="category-breakdown">${categoryBreakdown(summary)}</div>
      </section>
      <section class="panel recent-panel">
        <div class="section-heading"><div><p class="eyebrow">最近</p><h2>這個月的流水</h2></div><button type="button" data-go-view="history">全部紀錄</button></div>
        <div class="transaction-list compact">${transactionRows(monthlyTransactions.slice(0, 5), state.accounts)}</div>
      </section>
    </div>
  </section>`;
}

export function renderHistory(state, month, filters) {
  const results = filterTransactions(state.transactions, { month, ...filters });
  return `<section class="view history-view" aria-labelledby="history-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="history-title">每一筆，都有跡可循</h1><p>搜尋備註、分類或帳戶，快速回到當時的決定。</p></div></div>
    <section class="panel history-panel">
      <div class="filter-bar">
        <label class="search-field"><span class="visually-hidden">搜尋紀錄</span><span aria-hidden="true">⌕</span><input id="history-search" aria-label="搜尋紀錄" type="search" value="${escapeHtml(filters.query)}" placeholder="搜尋備註、分類、帳戶" /></label>
        <select id="history-type" aria-label="篩選類型"><option value="">全部類型</option>${Object.entries(TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${filters.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="history-account" aria-label="篩選帳戶"><option value="">全部帳戶</option>${state.accounts.map(account => `<option value="${account.id}" ${filters.account === account.id ? 'selected' : ''}>${escapeHtml(account.name)}</option>`).join('')}</select>
      </div>
      <div class="history-result-meta"><strong>${results.length} 筆紀錄</strong><span>以日期由新到舊</span></div>
      <div id="history-list" class="transaction-list">${transactionRows(results, state.accounts)}</div>
    </section>
  </section>`;
}

export function renderBudgets(state, month) {
  const progress = calculateBudgetProgress(state.budgets, state.transactions, month);
  return `<section class="view budgets-view" aria-labelledby="budgets-title">
    <div class="page-heading"><div><p class="eyebrow">${monthLabel(month)}</p><h1 id="budgets-title">預算是邊界，不是惩罰</h1><p>先從最容易失控的兩三個分類開始就好。</p></div></div>
    <div class="budgets-layout">
      <form id="budget-form" class="panel budget-form">
        <p class="eyebrow">新增邊界</p><h2>設一個每月上限</h2>
        <label><span>預算分類</span><select name="category" aria-label="預算分類">${EXPENSE_CATEGORIES.map(category => `<option value="${category}">${category}</option>`).join('')}</select></label>
        <label><span>每月上限</span><div class="inline-money"><small>NT$</small><input name="limit" aria-label="每月上限" type="number" min="1" step="1" inputmode="numeric" placeholder="5,000" required /></div></label>
        <button class="primary-button" type="submit">儲存預算</button>
      </form>
      <section class="panel budget-list-panel">
        <div class="section-heading"><div><p class="eyebrow">本月狀態</p><h2>${progress.length ? '拿捏得剛剛好' : '還沒有預算'}</h2></div><span>${progress.length} 個分類</span></div>
        <div class="budget-list">${
          progress.length
            ? progress
                .map(item => `<article class="budget-row ${item.status}">
                  ${categoryMark(item.category)}
                  <div class="budget-row-main"><span><strong>${escapeHtml(item.category)}預算</strong><small>${formatMoney(item.spent)} / ${formatMoney(item.limit)}</small></span><div class="progress-track"><i style="width:${Math.min(100, item.ratio * 100)}%"></i></div><p>${item.remaining >= 0 ? `還剩 ${formatMoney(item.remaining)}` : `已超出 ${formatMoney(Math.abs(item.remaining))}`}</p></div>
                  <button type="button" data-remove-budget="${escapeHtml(item.category)}" aria-label="移除 ${escapeHtml(item.category)} 預算">×</button>
                </article>`)
                .join('')
            : emptyState('先挑一個分類', '飲食、購物或娛樂，通常是最好的開始。')
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
    <div class="page-heading"><div><p class="eyebrow">時間軸</p><h1 id="insights-title">六個月的流向</h1><p>不用預測未來，先看見自己一直在做什麼。</p></div></div>
    <section class="panel trend-panel">
      <div class="chart-legend"><span><i class="income"></i>收入</span><span><i class="expense"></i>支出</span></div>
      <div id="trend-chart" class="trend-chart" role="img" aria-label="最近六個月收入與支出柱狀圖">
        ${trend
          .map(item => `<div class="trend-column"><div class="trend-bars"><i class="income" style="height:${Math.max(2, (item.income / maxAmount) * 100)}%" title="${shortMonthLabel(item.month)}收入 ${formatMoney(item.income)}"></i><i class="expense" style="height:${Math.max(2, (item.expense / maxAmount) * 100)}%" title="${shortMonthLabel(item.month)}支出 ${formatMoney(item.expense)}"></i></div><span>${shortMonthLabel(item.month)}</span></div>`)
          .join('')}
      </div>
    </section>
    <div class="insight-cards">
      <article class="insight-card coral"><p class="eyebrow">本月焦點</p><strong>${topCategory ? topCategory[0] : '還沒有足夠資料'}</strong><p>${topCategory ? `共 ${formatMoney(topCategory[1])}，佔本月支出 ${Math.round((topCategory[1] / summary.expense) * 100)}%。` : '記幾筆後，這裡會顯示主要流向。'}</p></article>
      <article class="insight-card blue"><p class="eyebrow">流動結果</p><strong>${summary.balance >= 0 ? '正向結餘' : '支出較高'}</strong><p>${summary.balance >= 0 ? `本月留下 ${formatMoney(summary.balance)}。` : `本月差額 ${formatMoney(Math.abs(summary.balance))}。`}</p></article>
      <article class="insight-card olive"><p class="eyebrow">記錄節奏</p><strong>${summary.count} 筆</strong><p>${summary.count ? `平均每筆 ${formatMoney(Math.round((summary.income + summary.expense) / summary.count))}。` : '從今天的第一筆開始。'}</p></article>
    </div>
  </section>`;
}

export function renderView(view, state, month, filters) {
  if (view === 'history') return renderHistory(state, month, filters);
  if (view === 'budgets') return renderBudgets(state, month);
  if (view === 'insights') return renderInsights(state, month);
  return renderOverview(state, month);
}
