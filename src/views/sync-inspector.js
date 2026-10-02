import { escapeHtml } from '../format.js';

function ids(values) {
  return Array.isArray(values) ? [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))] : [];
}

function waitedSince(value, now) {
  const startedAt = Date.parse(value || '');
  if (!Number.isFinite(startedAt)) return '等待同步';
  const minutes = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (minutes < 1) return '不到 1 分鐘';
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時`;
  return `${Math.floor(hours / 24)} 天`;
}

function changeLabel(item, fallback) {
  return String(item?.name || item?.label || item?.match || item?.month || item?.category || fallback || '')
    .trim();
}

function pendingRow({ kind, id, label, waited, detailId = '', retry = false }) {
  return `<article class="sync-inspector-item" data-kind="${escapeHtml(kind)}">
    <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(id)} · ${escapeHtml(waited)}</span></div>
    <div class="sync-inspector-actions">
      ${detailId ? `<button type="button" class="secondary-button" data-detail-id="${escapeHtml(detailId)}">查看</button>` : ''}
      ${retry ? '<button type="button" class="secondary-button" data-sync-retry aria-label="重試待上傳佇列">重試佇列</button>' : ''}
    </div>
  </article>`;
}

export function renderSyncInspector(state = {}, pending = {}, { now = Date.now() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number.isFinite(Number(now)) ? Number(now) : Date.parse(now);
  const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const transactions = new Map((state.transactions || []).map(item => [String(item?.id ?? ''), item]));
  const rows = [];

  ids(pending.upserts).forEach(id => {
    const item = transactions.get(id);
    rows.push(pendingRow({
      kind: 'transaction',
      id,
      label: changeLabel(item, '交易'),
      waited: waitedSince(item?.updatedAt || item?.createdAt, timestamp),
      detailId: item ? id : '',
      retry: true,
    }));
  });
  ids(pending.deletes).forEach(id => rows.push(pendingRow({
    kind: 'transaction-delete', id, label: transactions.get(id)?.name || '已刪除交易', waited: '等待同步', retry: true,
  })));

  const addChanges = (values, findItem, labelOf, kind) => {
    ids(values).forEach(id => {
      const item = findItem(id);
      rows.push(pendingRow({
        kind,
        id,
        label: labelOf(item, id),
        waited: waitedSince(item?.updatedAt || item?.createdAt, timestamp),
      }));
    });
  };
  const accounts = new Map((state.accounts || []).map(item => [String(item?.id ?? ''), item]));
  addChanges(pending.accountUpserts, id => accounts.get(id), (item, id) => `帳戶：${item?.name || id}`, 'account');
  addChanges(pending.accountDeletes, () => null, (_item, id) => `已移除帳戶：${id}`, 'account-delete');

  const budgets = new Map((state.budgets || []).map(item => [String(item?.category ?? ''), item]));
  addChanges(pending.budgetUpserts, id => budgets.get(id), (item, id) => `預算：${item?.category || id}`, 'budget');
  addChanges(pending.budgetDeletes, () => null, (_item, id) => `已移除預算：${id}`, 'budget-delete');

  const features = state.featureSettings || {};
  const featureNames = {
    recurringRules: item => `固定流水：${changeLabel(item, '未命名')}`,
    monthlySnapshots: item => `月結快照：${item?.month || '月份未知'}`,
    reconciliations: item => `對帳：${item?.date || item?.accountId || '未命名'}`,
    templates: item => `記帳模板：${changeLabel(item, '未命名')}`,
    categoryRules: item => `分類規則：${changeLabel(item, '未命名')}`,
  };
  Object.entries(featureNames).forEach(([collection, labelOf]) => {
    const keyOf = collection === 'monthlySnapshots' ? item => item?.month : item => item?.id;
    const byId = new Map((features[collection] || []).map(item => [String(keyOf(item) ?? ''), item]));
    addChanges(pending.featureUpserts?.[collection], id => byId.get(id), labelOf, `feature-${collection}`);
    addChanges(pending.featureDeletes?.[collection], () => null, (_item, id) => `已移除設定：${id}`, `feature-${collection}-delete`);
  });
  const hasFeatureDetails = Object.values(pending.featureUpserts || {}).some(values => ids(values).length) ||
    Object.values(pending.featureDeletes || {}).some(values => ids(values).length);
  if (pending.features && !hasFeatureDetails) rows.push(pendingRow({
    kind: 'settings', id: 'feature-settings', label: '功能設定', waited: '等待同步',
  }));

  if (!rows.length) return '<section class="sync-inspector"><p>目前沒有待上傳項目。</p></section>';
  return `<section class="sync-inspector" aria-label="待上傳項目">
    <p>尚有 ${rows.length} 項資料等候 Google Sheet 確認；連線恢復時會自動續傳。</p>
    <div class="sync-inspector-list">${rows.join('')}</div>
    <button type="button" class="secondary-button" data-sync-retry>重試待上傳項目</button>
  </section>`;
}
