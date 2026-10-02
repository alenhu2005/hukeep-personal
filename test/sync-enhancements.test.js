import { describe, expect, it } from 'vitest';
import { renderSyncInspector } from '../src/views/sync-inspector.js';
import { syncLedgerChangesToSheet } from '../src/services/import-proxy.js';
import {
  acknowledgePendingSheetChanges,
  hasPendingSheetChanges,
  updatePendingSheetChanges,
} from '../src/domain/ledger-sync.js';

const state = {
  accounts: [{ id: 'cash', name: '現金' }],
  transactions: [{
    id: 'refund-1', type: 'income', name: '咖啡退款', amount: 120, account: 'cash',
    date: '2026-10-01', createdAt: '2026-10-02T07:00:00.000Z', refundOf: 'purchase-1',
  }],
  budgets: [{ category: '飲食', limit: 3000 }],
  featureSettings: {
    recurringRules: [], monthlySnapshots: [], reconciliations: [],
    templates: [{
      id: 'template-1', label: '咖啡', name: '咖啡', type: 'expense', amount: 120,
      account: 'cash', category: '飲食', subcategory: '咖啡', createdAt: '2026-10-01T00:00:00.000Z',
    }],
    categoryRules: [{
      id: 'rule-1', match: '咖啡店', type: 'expense', category: '飲食', subcategory: '咖啡',
      createdAt: '2026-10-01T00:00:00.000Z',
    }],
  },
};

describe('新同步中繼資料', () => {
  it('未支援 enhancementsVersion 的 GAS 不會收到新資料寫入', async () => {
    const actions = [];
    const fetchImpl = async (_url, request) => {
      const payload = JSON.parse(request.body);
      actions.push(payload.action);
      return { ok: true, json: async () => ({ ok: true, data: { transferFeeModeVersion: 1 } }) };
    };

    await expect(syncLedgerChangesToSheet({
      endpoint: 'https://example.com/proxy',
      proxyToken: 'old-gas',
      state,
      changes: {
        upserts: ['refund-1'],
        featureUpserts: { templates: ['template-1'], categoryRules: ['rule-1'] },
      },
    }, { fetchImpl })).rejects.toThrow('更新 GAS');
    expect(actions).toEqual(['getLedgerCapabilities']);
  });

  it('退款解除連結保留待確認標記，直到支援版本成功確認', async () => {
    const actions = [];
    const fetchImpl = async (_url, request) => {
      actions.push(JSON.parse(request.body).action);
      return { ok: true, json: async () => ({ ok: true, data: { transferFeeModeVersion: 1 } }) };
    };
    const linked = { ...state.transactions[0] };
    const unlinked = { ...linked };
    delete unlinked.refundOf;
    const pending = updatePendingSheetChanges({}, { ...state, transactions: [linked] }, {
      ...state, transactions: [unlinked],
    });
    expect(pending.refundClears).toEqual(['refund-1']);
    expect(hasPendingSheetChanges(pending)).toBe(true);

    await expect(syncLedgerChangesToSheet({
      endpoint: 'https://example.com/unlink-proxy', proxyToken: 'old-gas',
      state: { ...state, transactions: [unlinked] },
      changes: { ...pending, upserts: ['refund-1'] },
    }, { fetchImpl })).rejects.toThrow('更新 GAS');
    expect(actions).toEqual(['getLedgerCapabilities']);

    const sent = { upserts: ['refund-1'], refundClears: ['refund-1'] };
    const remaining = acknowledgePendingSheetChanges(sent, sent,
      { ...state, transactions: [unlinked] }, { ...state, transactions: [unlinked] });
    expect(remaining.refundClears || []).toEqual([]);
    expect(hasPendingSheetChanges(remaining)).toBe(false);
  });

  it('同一 ID 的刪除可在上傳前、上傳中與上傳後還原而不形成重複列', () => {
    const item = { id: 'same-id', name: '退款', amount: 50 };
    const before = { ...state, transactions: [item] };
    const deleted = { ...state, transactions: [] };
    const deletion = updatePendingSheetChanges({}, before, deleted);
    expect(deletion.deletes).toEqual(['same-id']);

    const restoredBeforeUpload = updatePendingSheetChanges(deletion, deleted, before);
    expect(restoredBeforeUpload).toMatchObject({ upserts: ['same-id'], deletes: [] });

    const restoredDuringUpload = acknowledgePendingSheetChanges(restoredBeforeUpload, deletion, deleted, before);
    expect(restoredDuringUpload).toMatchObject({ upserts: ['same-id'], deletes: [] });

    const afterDeleteAck = acknowledgePendingSheetChanges(deletion, deletion, deleted, deleted);
    const restoredAfterUpload = updatePendingSheetChanges(afterDeleteAck, deleted, before);
    expect(restoredAfterUpload).toMatchObject({ upserts: ['same-id'], deletes: [] });
    expect(before.transactions.filter(transaction => transaction.id === 'same-id')).toHaveLength(1);
  });

  it('新版 GAS 回報 enhancementsVersion 後才確認模板、規則與退款關聯', async () => {
    const payloads = [];
    const fetchImpl = async (_url, request) => {
      const payload = JSON.parse(request.body);
      payloads.push(payload);
      const data = payload.action === 'getLedgerCapabilities'
        ? { enhancementsVersion: 1 }
        : {
            accountCount: 1, transactionCount: 1, budgetCount: 1,
            featureSettingsVersion: 1, enhancementsVersion: 1,
          };
      return { ok: true, json: async () => ({ ok: true, data }) };
    };

    await expect(syncLedgerChangesToSheet({
      endpoint: 'https://example.com/new-proxy',
      proxyToken: 'new-gas',
      state,
      changes: {
        upserts: ['refund-1'],
        featureUpserts: { templates: ['template-1'], categoryRules: ['rule-1'] },
      },
    }, { fetchImpl })).resolves.toEqual({ accountCount: 1, transactionCount: 1, budgetCount: 1 });
    expect(payloads[1].changes.transactions[0].refundOf).toBe('purchase-1');
    expect(payloads[1].changes.featureSettingsDelta.templates).toHaveLength(1);
    expect(payloads[1].changes.featureSettingsDelta.categoryRules).toHaveLength(1);
  });

  it('列出個別交易、帳戶與設定的等候時間及操作，並逸出使用者文字', () => {
    const markup = renderSyncInspector({
      ...state,
      transactions: [{ ...state.transactions[0], name: '<咖啡退款>' }],
    }, {
      upserts: ['refund-1'],
      deletes: ['removed-1'],
      accountUpserts: ['cash'],
      accountDeletes: ['closed'],
      budgetUpserts: ['飲食'],
      featureUpserts: { templates: ['template-1'], categoryRules: ['rule-1'] },
      featureDeletes: { recurringRules: ['old-rule'] },
    }, { now: Date.parse('2026-10-02T08:00:00.000Z') });

    expect(markup).toContain('data-sync-retry');
    expect(markup).toContain('data-detail-id="refund-1"');
    expect(markup).toContain('&lt;咖啡退款&gt;');
    expect(markup).toContain('1 小時');
    expect(markup).toContain('帳戶：現金');
    expect(markup).toContain('記帳模板：咖啡');
    expect(markup).toContain('分類規則：咖啡店');
    expect(markup).not.toContain('正在同步');
  });
});
