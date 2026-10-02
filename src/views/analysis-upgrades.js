import { escapeHtml, formatMoney } from '../format.js';

function amountBar(value, max) {
  return Math.min(100, Math.round(Math.abs(Number(value) || 0) / Math.max(1, max) * 100));
}

function periodAttrs(key) {
  if (!key) return '';
  return /^\d{4}-\d{2}$/.test(key)
    ? `data-month="${escapeHtml(key)}"`
    : `data-date="${escapeHtml(key)}"`;
}

function drill(kind, key, fields = {}) {
  const dates = /^\d{4}-\d{2}$/.test(key)
    ? (() => {
        const [year, month] = key.split('-').map(Number);
        return { start: `${key}-01`, end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
      })()
    : key ? { start: key, end: key } : {};
  const attrs = Object.entries({ ...dates, ...fields })
    .filter(([, value]) => value !== '' && value != null)
    .map(([name, value]) => `data-${name}="${escapeHtml(value)}"`).join(' ');
  return `data-analysis-drill="${kind}" ${periodAttrs(key || '')} ${attrs}`;
}

function empty(label) {
  return `<p class="analysis-upgrade-empty">${escapeHtml(label)}</p>`;
}

function currentRangeFields(workspace) {
  return {
    start: workspace.observedRange?.from || workspace.range.from,
    end: workspace.observedRange?.to || workspace.range.to,
  };
}

function renderIncomeExpense(workspace) {
  const rows = workspace.incomeExpenseSeries || [];
  const max = Math.max(1, workspace.incomeExpenseMax || 0);
  if (!rows.length) return empty('這段期間沒有可顯示的收支。');
  return `<section class="analysis-upgrade-block" aria-label="收入與生活支出趨勢">
    <header><strong>收入與生活支出</strong><small>同一時間軸，退款以支出減項呈現</small></header>
    <div class="analysis-upgrade-legend"><span class="income">收入</span><span class="expense">生活支出</span></div>
    <div class="analysis-upgrade-paired${rows.length > 7 ? ' is-wide' : ''}">
      ${rows.map(row => `<div class="analysis-upgrade-pair">
        <strong>${escapeHtml(row.label)}</strong>
        <button type="button" class="analysis-upgrade-value income" ${drill('income', row.key)} aria-label="${escapeHtml(row.label)}收入 ${formatMoney(row.income)}">
          <i><b style="width:${amountBar(row.income, max)}%"></b></i><span>${formatMoney(row.income)}</span>
        </button>
        <button type="button" class="analysis-upgrade-value expense${row.expense < 0 ? ' is-negative' : ''}" ${drill('expense', row.key)} aria-label="${escapeHtml(row.label)}生活支出 ${formatMoney(row.expense, { showPlus: true })}">
          <i><b style="width:${amountBar(row.expense, max)}%"></b></i><span>${formatMoney(row.expense, { showPlus: true })}</span>
        </button>
      </div>`).join('')}
    </div>
  </section>`;
}

function categoryBreadcrumb(filters) {
  if (filters.subcategory) {
    return `<button type="button" class="analysis-upgrade-back" data-insight-subcategory="">‹ 返回 ${escapeHtml(filters.category || '分類')}</button>`;
  }
  return filters.category
    ? '<button type="button" class="analysis-upgrade-back" data-insight-category="">‹ 返回全部大分類</button>'
    : '';
}

function renderCategorySeries(workspace, filters, type) {
  const seriesList = workspace[`${type}ComparisonSeries`] || [];
  const selected = filters.category
    ? seriesList.find(row => row.category === filters.category)
    : seriesList.find(row => row.amount !== 0) || seriesList[0];
  if (!selected?.series?.length) return empty('本期和對照期都沒有分類資料。');
  const subcategory = (workspace[`${type}SubcategorySeries`] || []).find(row => row.subcategory === filters.subcategory);
  if (filters.subcategory && !subcategory) return empty('這段期間沒有該小分類資料。');
  const series = subcategory?.series || selected.series;
  const title = subcategory ? `${selected.category} · ${subcategory.subcategory}` : selected.category;
  const max = Math.max(1, ...series.flatMap(row => [Math.abs(row.amount), Math.abs(row.previousAmount)]));
  return `<section class="analysis-upgrade-block" aria-label="${escapeHtml(selected.category)}本期與前期趨勢">
    <header><strong>${escapeHtml(title)}本期與前期</strong><small>前期使用相同經過天數</small></header>
    <div class="analysis-upgrade-legend"><span class="current">本期</span><span class="previous">前期</span></div>
    <div class="analysis-upgrade-paired${series.length > 7 ? ' is-wide' : ''}">
      ${series.map(row => `<div class="analysis-upgrade-pair">
        <strong>${escapeHtml(row.label)}</strong>
        <button type="button" class="analysis-upgrade-value current${row.amount < 0 ? ' is-negative' : ''}" ${drill(type, row.key, { category: selected.category, ...(subcategory ? { subcategory: subcategory.subcategory } : {}) })} aria-label="本期 ${escapeHtml(title)} ${escapeHtml(row.label)} ${formatMoney(row.amount, { showPlus: true })}">
          <i><b style="width:${amountBar(row.amount, max)}%"></b></i><span>${formatMoney(row.amount, { showPlus: true })}</span>
        </button>
        <button type="button" class="analysis-upgrade-value previous${row.previousAmount < 0 ? ' is-negative' : ''}" ${drill(type, row.previousKey, { category: selected.category, ...(subcategory ? { subcategory: subcategory.subcategory } : {}) })} aria-label="前期 ${escapeHtml(title)} ${escapeHtml(row.label)} ${formatMoney(row.previousAmount, { showPlus: true })}">
          <i><b style="width:${amountBar(row.previousAmount, max)}%"></b></i><span>${formatMoney(row.previousAmount, { showPlus: true })}</span>
        </button>
      </div>`).join('')}
    </div>
  </section>`;
}

function renderComposition(workspace, filters, type) {
  const composition = workspace[`${type}Composition`];
  if (!composition?.series?.length) return empty('選取一個有支出的分類後，這裡會顯示小分類構成。');
  const children = workspace[`${type}SubcategorySeries`] || [];
  if (filters.subcategory && !children.some(child => child.subcategory === filters.subcategory)) {
    return empty('這段期間沒有該小分類資料。');
  }
  const shownChildren = filters.subcategory ? children.filter(child => child.subcategory === filters.subcategory) : children;
  const series = filters.subcategory
    ? composition.series.map(row => ({ ...row, parts: row.parts.filter(part => part.subcategory === filters.subcategory) }))
    : composition.series;
  const max = Math.max(1, ...series.map(row => row.parts.reduce((sum, part) => sum + Math.abs(part.amount), 0)));
  return `<section class="analysis-upgrade-block" aria-label="${escapeHtml(composition.category)}小分類時間構成">
    ${categoryBreadcrumb(filters)}
    <header><strong>${escapeHtml(composition.category)}小分類構成</strong><small>每條時間長條依金額共用比例尺</small></header>
    <div class="analysis-upgrade-legend">${shownChildren.map((child, index) => `<button type="button" class="part-${index % 6}" ${drill(type, '', { category: composition.category, subcategory: child.subcategory, ...currentRangeFields(workspace) })} aria-label="篩選 ${escapeHtml(child.subcategory)}">${escapeHtml(child.subcategory)}</button>`).join('')}</div>
    <div class="analysis-upgrade-stacks${series.length > 7 ? ' is-wide' : ''}">
      ${series.map(row => `<div class="analysis-upgrade-stack-row"><strong>${escapeHtml(row.label)}</strong><div class="analysis-upgrade-stack">
        ${row.parts.map(part => {
          const index = shownChildren.findIndex(child => child.subcategory === part.subcategory);
          return `<button type="button" class="part-${Math.max(0, index) % 6}${part.amount < 0 ? ' is-negative' : ''}" style="width:${amountBar(part.amount, max)}%" ${drill(type, row.key, { category: composition.category, subcategory: part.subcategory })} title="${escapeHtml(part.subcategory)} ${formatMoney(part.amount, { showPlus: true })}" aria-label="${escapeHtml(composition.category)} ${escapeHtml(part.subcategory)} ${escapeHtml(row.label)} ${formatMoney(part.amount, { showPlus: true })}"></button>`;
        }).join('')}
      </div></div>`).join('')}
    </div>
  </section>`;
}

function renderSubcategoryPicker(workspace, filters, type) {
  const children = workspace[`${type}SubcategorySeries`] || [];
  const selected = Array.isArray(filters.compareSubcategories) ? filters.compareSubcategories : [];
  const chosen = selected.filter(value => children.some(child => child.subcategory === value));
  const max = Math.max(1, ...children.filter(child => chosen.includes(child.subcategory))
    .flatMap(child => child.series.map(row => Math.abs(row.amount))));
  const labels = children.map(child => `<button type="button" class="analysis-upgrade-chip${chosen.includes(child.subcategory) ? ' is-selected' : ''}" data-insight-compare-subcategory="${escapeHtml(child.subcategory)}" aria-pressed="${chosen.includes(child.subcategory)}">${escapeHtml(child.subcategory)}</button>`).join('');
  const chart = chosen.length < 2
    ? empty('請選擇至少兩個小分類進行同尺度比較。')
    : `<div class="analysis-upgrade-stacks${(children.find(child => chosen.includes(child.subcategory))?.series.length || 0) > 7 ? ' is-wide' : ''}">${(children.find(child => chosen.includes(child.subcategory))?.series || []).map((row, index) => `<div class="analysis-upgrade-compare-row"><strong>${escapeHtml(row.label)}</strong><div>${children.filter(child => chosen.includes(child.subcategory)).map((child, partIndex) => {
        const point = child.series[index];
        return point ? `<button type="button" class="analysis-upgrade-compare-value part-${partIndex % 6}${point.amount < 0 ? ' is-negative' : ''}" ${drill(type, point.key, { category: workspace[`${type}Composition`]?.category, subcategory: child.subcategory })} aria-label="${escapeHtml(child.subcategory)} ${escapeHtml(row.label)} ${formatMoney(point.amount, { showPlus: true })}"><i><b style="width:${amountBar(point.amount, max)}%"></b></i><span>${escapeHtml(child.subcategory)} ${formatMoney(point.amount, { showPlus: true })}</span></button>` : '';
      }).join('')}</div></div>`).join('')}</div>`;
  return `<section class="analysis-upgrade-block" aria-label="小分類多選比較">
    <header><strong>小分類多選比較</strong><small>選取項目使用同一金額比例尺</small></header>
    <div class="analysis-upgrade-chips">${labels || empty('這個分類還沒有小分類資料。')}</div>
    ${chart}
  </section>`;
}

function renderBudgetHistory(workspace, filters) {
  if (filters.period !== 'month') return empty('切換到本月查看累計支出與月預算。');
  const groups = workspace.budgetCumulativeSeries || [];
  if (!groups.length) return empty('本月沒有分類預算可比較。');
  const max = Math.max(1, ...groups.flatMap(group => group.series.flatMap(row => [row.amount, row.proratedBudget])));
  const historicalMonth = workspace.currentDate
    && workspace.currentDate.slice(0, 7) !== workspace.range?.from?.slice(0, 7);
  return `<section class="analysis-upgrade-block" aria-label="累計生活支出與按日攤提預算">
    <header><strong>累計生活支出與預算</strong><small>${historicalMonth ? '目前設定的月預算（非歷史版本）' : '預算線按本月經過天數等比例攤提'}</small></header>
    <div class="analysis-upgrade-legend"><span class="actual">累計支出</span><span class="budget">按日攤提預算</span></div>
    ${groups.map(group => `<div class="analysis-upgrade-budget-group"><strong>${escapeHtml(group.category)}</strong><small>月預算 ${formatMoney(group.limit)}</small>
      <div class="analysis-upgrade-budget-chart" role="group" aria-label="${escapeHtml(group.category)}累計支出">
        ${group.series.map((row, index) => `<button type="button" class="analysis-upgrade-budget-day${row.amount < 0 ? ' is-negative' : ''}" ${drill('expense', '', { category: group.category, start: workspace.range.from, end: row.key })} title="${escapeHtml(row.key)} 支出累計 ${formatMoney(row.amount)}，按日攤提預算 ${formatMoney(row.proratedBudget)}" aria-label="${escapeHtml(row.key)} ${escapeHtml(group.category)}累計支出 ${formatMoney(row.amount)}，按日攤提預算 ${formatMoney(row.proratedBudget)}">
          <i class="actual" style="height:${amountBar(row.amount, max)}%"></i><b class="budget" style="bottom:${amountBar(row.proratedBudget, max)}%"></b><small>${index % 5 === 0 || index === group.series.length - 1 ? Number(row.key.slice(8)) : ''}</small>
        </button>`).join('')}
      </div>
    </div>`).join('')}
  </section>`;
}

function renderExpenseChanges(workspace) {
  const rows = workspace.expenseChanges || [];
  if (!rows.length) return empty('沒有可比較的支出分類。');
  const max = Math.max(1, ...rows.map(row => Math.abs(row.changeAmount)));
  return `<section class="analysis-upgrade-block" aria-label="支出分類變化絕對金額排序">
    <header><strong>支出變化</strong><small>依變化金額絕對值排序</small></header>
    <div class="analysis-upgrade-changes">${rows.map(row => {
      const percent = row.changePercent == null ? '前期無正數基期，不計百分比' : `較前期 ${row.changePercent > 0 ? '+' : ''}${row.changePercent}%`;
      return `<button type="button" class="analysis-upgrade-change${row.changeAmount < 0 ? ' is-negative' : ''}" ${drill('expense', '', { category: row.category, ...currentRangeFields(workspace) })} aria-label="${escapeHtml(row.category)}變化 ${formatMoney(row.changeAmount, { showPlus: true })}，${percent}">
        <span><strong>${escapeHtml(row.category)}</strong><small>${percent}</small></span><i><b style="width:${amountBar(row.changeAmount, max)}%"></b></i><strong>${formatMoney(row.changeAmount, { showPlus: true })}</strong>
      </button>`;
    }).join('')}</div>
  </section>`;
}

function renderMerchants(workspace) {
  const rows = workspace.merchantGroups || [];
  if (!rows.length) return empty('沒有可辨識的商家或品項。');
  const max = Math.max(1, ...rows.map(row => Math.abs(row.amount)));
  return `<section class="analysis-upgrade-block" aria-label="商家與品項支出排行">
    <header><strong>商家／品項排行</strong><small>優先使用商家名稱，缺少時以品項名稱呈現</small></header>
    <div class="analysis-upgrade-changes">${rows.map(row => `<button type="button" class="analysis-upgrade-change${row.amount < 0 ? ' is-negative' : ''}" ${drill('expense', '', { ...(row.kind === 'merchant' ? { merchant: row.merchant } : { name: row.name }), ...currentRangeFields(workspace) })} aria-label="${row.kind === 'merchant' ? '商家' : '品項'} ${escapeHtml(row.label)} ${formatMoney(row.amount, { showPlus: true })}">
      <span><strong>${escapeHtml(row.label)}</strong><small>${row.kind === 'merchant' ? '商家' : '品項'} · ${row.count} 筆</small></span><i><b style="width:${amountBar(row.amount, max)}%"></b></i><strong>${formatMoney(row.amount, { showPlus: true })}</strong>
    </button>`).join('')}</div>
  </section>`;
}

function renderCategoryUpgrades(workspace, filters, type) {
  return `<section class="analysis-upgrades analysis-upgrades-${type}">
    ${renderCategorySeries(workspace, filters, type)}
    ${renderComposition(workspace, filters, type)}
    ${renderSubcategoryPicker(workspace, filters, type)}
  </section>`;
}

function renderExpenseUpgrades(workspace, filters) {
  return `${renderCategoryUpgrades(workspace, filters, 'expense')}
    <section class="analysis-upgrades analysis-upgrades-expense">
    ${renderBudgetHistory(workspace, filters)}
    ${renderExpenseChanges(workspace)}
    ${renderMerchants(workspace)}
  </section>`;
}

function renderInvestmentHistory(workspace) {
  const rows = workspace.liquidInvestmentSeries || [];
  const from = workspace.range?.from || '';
  const to = workspace.range?.to || '';
  const checkpoints = (workspace.investmentCheckpoints || []).filter(item => item.date >= from && item.date <= to);
  if (!rows.length) return empty('沒有足夠帳戶資料建立本金走勢。');
  const max = Math.max(1, ...rows.flatMap(row => [Math.abs(row.liquid), Math.abs(row.investmentPrincipal)]));
  return `<section class="analysis-upgrade-block" aria-label="流動帳戶與投資本金歷史">
    <header><strong>流動資產與投資本金</strong><small>只累計帳戶流水；市值只在真實對帳點顯示</small></header>
    <div class="analysis-upgrade-legend"><span class="liquid">流動帳戶</span><span class="principal">投資本金</span></div>
    <div class="analysis-upgrade-paired${rows.length > 7 ? ' is-wide' : ''}">${rows.map(row => `<div class="analysis-upgrade-pair">
      <strong>${escapeHtml(row.label)}</strong>
      <button type="button" class="analysis-upgrade-value liquid${row.liquid < 0 ? ' is-negative' : ''}" ${drill('account', '', { 'account-group': 'liquid', start: '0001-01-01', end: row.through || row.key })} aria-label="${escapeHtml(row.label)}流動帳戶餘額 ${formatMoney(row.liquid, { showPlus: true })}"><i><b style="width:${amountBar(row.liquid, max)}%"></b></i><span>${formatMoney(row.liquid, { showPlus: true })}</span></button>
      <button type="button" class="analysis-upgrade-value principal${row.investmentPrincipal < 0 ? ' is-negative' : ''}" ${drill('account', '', { 'account-group': 'investment', start: '0001-01-01', end: row.through || row.key })} aria-label="${escapeHtml(row.label)}投資本金 ${formatMoney(row.investmentPrincipal, { showPlus: true })}"><i><b style="width:${amountBar(row.investmentPrincipal, max)}%"></b></i><span>${formatMoney(row.investmentPrincipal, { showPlus: true })}</span></button>
    </div>`).join('')}</div>
    <div class="analysis-upgrade-checkpoints"><strong>投資市值對帳點</strong>${checkpoints.length
      ? checkpoints.map(item => `<p>${escapeHtml(item.date)} · 本金 ${formatMoney(item.principal)} · 對帳市值 ${formatMoney(item.marketValue)}</p>`).join('')
      : '<p>這段期間沒有手動投資市值對帳點。</p>'}</div>
  </section>`;
}

export function renderAnalysisUpgrades(_state, workspace, filters = {}) {
  if (filters.section === 'overview') {
    return `<section class="analysis-upgrades analysis-upgrades-overview">${renderIncomeExpense(workspace)}</section>`;
  }
  if (filters.section === 'expense') return renderExpenseUpgrades(workspace, filters);
  if (filters.section === 'income') return renderCategoryUpgrades(workspace, filters, 'income');
  if (filters.section === 'investment') {
    return `<section class="analysis-upgrades analysis-upgrades-investment">${renderInvestmentHistory(workspace)}</section>`;
  }
  return '';
}
