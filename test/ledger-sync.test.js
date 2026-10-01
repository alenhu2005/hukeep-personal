import { describe, expect, it } from 'vitest';
import {
  acknowledgePendingSheetChanges,
  hasPendingSheetChanges,
  mergeLedgerStates,
  mergeConcurrentLedgerState,
  reconcileLedgerFromSheet,
  updatePendingSheetChanges,
} from '../src/domain/ledger-sync.js';
import { syncLedgerChangesToSheet } from '../src/services/import-proxy.js';

function state(transactions = [], options = {}) {
  return {
    schemaVersion: 1,
    accounts: options.accounts ?? [],
    transactions,
    budgets: options.budgets ?? [],
    preferences: options.preferences ?? { theme: 'system' },
    featureSettings: options.featureSettings,
  };
}

describe('Sheet 雙向更新合併', () => {
  it('將本機交易編輯套用到最新狀態，同時保留另一分頁的新增與修改', () => {
    const base = state([
      { id: 't1', name: '原始 T1' },
      { id: 't2', name: '原始 T2' },
    ], {
      accounts: [{ id: 'cash', name: '原始現金' }, { id: 'bank', name: '原始銀行' }],
      budgets: [{ category: '飲食', limit: 1000 }, { category: '交通', limit: 500 }],
    });
    const intended = state([
      { id: 't1', name: '本機 T1 編輯' },
      { id: 't2', name: '原始 T2' },
    ], {
      accounts: [{ id: 'cash', name: '本機現金' }, { id: 'bank', name: '原始銀行' }],
      budgets: [{ category: '飲食', limit: 1200 }, { category: '交通', limit: 500 }],
    });
    const latest = state([
      { id: 't1', name: '最新 T1' },
      { id: 't2', name: '另一分頁 T2 編輯' },
      { id: 't3', name: '另一分頁新增' },
    ], {
      accounts: [
        { id: 'cash', name: '最新現金' },
        { id: 'bank', name: '另一分頁銀行' },
        { id: 'line', name: '另一分頁新增帳戶' },
      ],
      budgets: [
        { category: '飲食', limit: 1100 },
        { category: '交通', limit: 700 },
        { category: '娛樂', limit: 900 },
      ],
    });

    const merged = mergeConcurrentLedgerState(base, intended, latest);
    expect(merged.transactions).toEqual([
      intended.transactions[0],
      latest.transactions[1],
      latest.transactions[2],
    ]);
    expect(merged.accounts).toEqual([
      intended.accounts[0],
      latest.accounts[1],
      latest.accounts[2],
    ]);
    expect(merged.budgets).toEqual([
      intended.budgets[0],
      latest.budgets[1],
      latest.budgets[2],
    ]);
  });

  it('套用本機明確刪除，但保留另一分頁新增的交易', () => {
    const base = state([{ id: 'deleted', name: '原始記錄' }]);
    const intended = state([]);
    const latest = state([
      { id: 'deleted', name: '另一分頁編輯' },
      { id: 'remote-new', name: '另一分頁新增' },
    ]);

    expect(mergeConcurrentLedgerState(base, intended, latest).transactions).toEqual([
      latest.transactions[1],
    ]);
  });

  it('只套用本機功能設定與偏好異動，保留其他分頁的設定', () => {
    const base = state([], {
      preferences: { theme: 'system', proxyEndpoint: 'https://old.example' },
      featureSettings: {
        recurringRules: [{ id: 'local-rule', name: '原始規則' }, { id: 'remote-rule', name: '原始遠端規則' }],
        monthlySnapshots: [{ month: '2026-08', assetTotal: 10 }],
        reconciliations: [{ id: 'local-reconciliation', note: '原始對帳' }],
      },
    });
    const intended = state([], {
      preferences: { theme: 'dark', proxyEndpoint: 'https://old.example' },
      featureSettings: {
        recurringRules: [{ id: 'local-rule', name: '本機規則' }, { id: 'remote-rule', name: '原始遠端規則' }],
        monthlySnapshots: [{ month: '2026-08', assetTotal: 12 }],
        reconciliations: [{ id: 'local-reconciliation', note: '本機對帳' }],
      },
    });
    const latest = state([], {
      preferences: { theme: 'system', proxyEndpoint: 'https://remote.example', locale: 'zh-Hant' },
      featureSettings: {
        recurringRules: [
          { id: 'local-rule', name: 'Sheet 舊規則' },
          { id: 'remote-rule', name: '另一分頁規則' },
          { id: 'remote-new-rule', name: '另一分頁新增' },
        ],
        monthlySnapshots: [
          { month: '2026-08', assetTotal: 11 },
          { month: '2026-09', assetTotal: 30 },
        ],
        reconciliations: [
          { id: 'local-reconciliation', note: 'Sheet 舊對帳' },
          { id: 'remote-reconciliation', note: '另一分頁新增' },
        ],
      },
    });

    const merged = mergeConcurrentLedgerState(base, intended, latest);
    expect(merged.preferences).toEqual({
      theme: 'dark',
      proxyEndpoint: 'https://remote.example',
      locale: 'zh-Hant',
    });
    expect(merged.featureSettings).toEqual({
      recurringRules: [
        intended.featureSettings.recurringRules[0],
        latest.featureSettings.recurringRules[1],
        latest.featureSettings.recurringRules[2],
      ],
      monthlySnapshots: [
        intended.featureSettings.monthlySnapshots[0],
        latest.featureSettings.monthlySnapshots[1],
      ],
      reconciliations: [
        intended.featureSettings.reconciliations[0],
        latest.featureSettings.reconciliations[1],
      ],
    });
  });

  it('Sheet 已刪除的既有交易會從網頁移除', () => {
    const local = state([
      { id: 'kept', updatedAt: '2026-08-29T06:00:00.000Z' },
      { id: 'deleted-in-sheet', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'kept', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    expect(reconcileLedgerFromSheet(local, remote).transactions).toEqual(remote.transactions);
  });

  it('只把仍待上傳的本機新增或修改覆蓋回 Sheet 最新資料', () => {
    const local = state([
      { id: 'local-pending', name: '我剛修改', updatedAt: '2026-08-29T06:02:00.000Z' },
      { id: 'local-new', name: '尚未上傳的新資料', updatedAt: '2026-08-29T06:02:00.000Z' },
      { id: 'stale-local', name: '舊本機資料', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'local-pending', name: 'Sheet 舊資料', updatedAt: '2026-08-29T06:01:00.000Z' },
      { id: 'remote-only', name: 'Sheet 新資料', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = reconcileLedgerFromSheet(local, remote, {
      upserts: ['local-pending', 'local-new'],
      deletes: [],
    });
    expect(result.transactions).toEqual([
      local.transactions[0],
      remote.transactions[1],
      local.transactions[1],
    ]);
  });

  it('本機待上傳刪除不會被 Sheet 背景讀取復活', () => {
    const remote = state([
      { id: 'pending-delete', updatedAt: '2026-08-29T06:01:00.000Z' },
      { id: 'kept', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = reconcileLedgerFromSheet(state([]), remote, {
      upserts: [],
      deletes: ['pending-delete'],
    });
    expect(result.transactions.map(transaction => transaction.id)).toEqual(['kept']);
  });

  it('從前後狀態建立不可變的待同步新增與刪除清單', () => {
    const before = state([
      { id: 'edited', name: '舊名稱' },
      { id: 'deleted', name: '要刪除' },
    ]);
    const after = state([
      { id: 'edited', name: '新名稱' },
      { id: 'added', name: '新增' },
    ]);
    const previous = { upserts: ['restored'], deletes: ['added'] };

    expect(updatePendingSheetChanges(previous, before, after)).toEqual({
      upserts: ['restored', 'edited', 'added'],
      deletes: ['deleted'],
      accountUpserts: [],
      accountDeletes: [],
      budgetUpserts: [],
      budgetDeletes: [],
      featureUpserts: { recurringRules: [], monthlySnapshots: [], reconciliations: [] },
      featureDeletes: { recurringRules: [], monthlySnapshots: [], reconciliations: [] },
      features: false,
    });
    expect(previous).toEqual({ upserts: ['restored'], deletes: ['added'] });
  });

  it('追蹤帳戶與預算的異動，並在讀取 Sheet 時保留尚未送出的版本', () => {
    const before = state([], {
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 100 }],
      budgets: [{ category: '飲食', limit: 3000 }],
    });
    const after = state([], {
      accounts: [{ id: 'cash', name: '現金', icon: '現', openingBalance: 200 }],
      budgets: [{ category: '飲食', limit: 4500 }],
    });
    const pending = updatePendingSheetChanges({}, before, after);
    const remote = state([], {
      accounts: [
        { id: 'cash', name: '現金', icon: '現', openingBalance: 100 },
        { id: 'line', name: 'LINE', icon: 'L', openingBalance: 50 },
      ],
      budgets: [
        { category: '飲食', limit: 3000 },
        { category: '娛樂', limit: 1200 },
      ],
    });

    expect(pending).toMatchObject({
      accountUpserts: ['cash'],
      budgetUpserts: ['飲食'],
    });
    expect(reconcileLedgerFromSheet(after, remote, pending)).toMatchObject({
      accounts: [
        { id: 'cash', openingBalance: 200 },
        { id: 'line', openingBalance: 50 },
      ],
      budgets: [
        { category: '飲食', limit: 4500 },
        { category: '娛樂', limit: 1200 },
      ],
    });
  });

  it('以較新的後台 AI 審查結果取代本機待審草稿', () => {
    const local = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:00:00.000Z', aiStatus: 'pending' },
    ]);
    const remote = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:01:00.000Z', aiStatus: 'reviewed' },
    ]);

    expect(mergeLedgerStates(local, remote).transactions).toEqual(remote.transactions);
  });

  it('保留時間較新的人工修改，並合併兩邊獨有的記錄', () => {
    const local = state([
      {
        id: 'voice:1',
        updatedAt: '2026-08-29T06:02:00.000Z',
        userEditedAt: '2026-08-29T06:02:00.000Z',
        name: '我改的',
      },
      { id: 'local-only', updatedAt: '2026-08-29T06:00:00.000Z' },
    ]);
    const remote = state([
      { id: 'voice:1', updatedAt: '2026-08-29T06:01:00.000Z', name: 'AI 改的' },
      { id: 'remote-only', updatedAt: '2026-08-29T06:01:00.000Z' },
    ]);

    const result = mergeLedgerStates(local, remote);
    expect(result.transactions.map(transaction => transaction.id)).toEqual([
      'voice:1',
      'local-only',
      'remote-only',
    ]);
    expect(result.transactions[0].name).toBe('我改的');
  });

  it('同步 Sheet 的帳戶與預算，但保留本機偏好設定', () => {
    const local = state([], {
      accounts: [{ id: 'cash', openingBalance: 1 }],
      budgets: [{ category: '飲食', limit: 1 }],
      preferences: { theme: 'dark', proxyEndpoint: 'https://example.com' },
    });
    const remote = state([], {
      accounts: [{ id: 'cash', openingBalance: 5000 }],
      budgets: [{ category: '飲食', limit: 6000 }],
    });

    expect(mergeLedgerStates(local, remote)).toMatchObject({
      accounts: remote.accounts,
      budgets: remote.budgets,
      preferences: local.preferences,
    });
  });

  it('Sheet 空帳戶或缺少預算時不清除本機設定', () => {
    const local = state([], {
      accounts: [{ id: 'cash', openingBalance: 100 }],
      budgets: [{ category: '交通', limit: 2000 }],
    });
    const result = mergeLedgerStates(local, {
      schemaVersion: 1,
      accounts: [],
      transactions: [],
    });

    expect(result.accounts).toEqual(local.accounts);
    expect(result.budgets).toEqual(local.budgets);
  });

  it('容忍空狀態與無效時間，同時保留本機版本', () => {
    expect(mergeLedgerStates(null, null)).toEqual({
      schemaVersion: 1,
      accounts: [],
      transactions: [],
      budgets: [],
      preferences: {},
      featureSettings: {},
    });

    const local = state([{ id: 'same', updatedAt: 'not-a-date', name: '本機' }]);
    const remote = state([{ id: 'same', updatedAt: '', name: 'Sheet' }]);
    expect(mergeLedgerStates(local, remote).transactions[0].name).toBe('本機');
  });

  it('把功能設定併入同步佇列，並保留尚未送出的本機功能設定', () => {
    const before = state([], { featureSettings: { recurringRules: [], monthlySnapshots: [], reconciliations: [] } });
    const after = state([], { featureSettings: { recurringRules: [{ id: 'r1' }], monthlySnapshots: [], reconciliations: [] } });
    const pending = updatePendingSheetChanges({}, before, after);
    expect(pending.features).toBe(true);
    expect(hasPendingSheetChanges(pending)).toBe(true);

    const remote = state([], { featureSettings: { recurringRules: [], monthlySnapshots: [{ month: '2026-08' }], reconciliations: [] } });
    expect(reconcileLedgerFromSheet(after, remote, pending).featureSettings).toEqual({
      recurringRules: after.featureSettings.recurringRules,
      monthlySnapshots: remote.featureSettings.monthlySnapshots,
      reconciliations: [],
    });
    expect(reconcileLedgerFromSheet(before, remote, {}).featureSettings).toEqual(remote.featureSettings);
    expect(hasPendingSheetChanges({})).toBe(false);
    expect(mergeLedgerStates(after, state([])).featureSettings).toEqual(after.featureSettings);
  });

  it('功能設定按項目合併跨裝置編輯，並將本機刪除套用到 Sheet 最新狀態', () => {
    const before = state([], { featureSettings: {
      recurringRules: [{ id: 'deleted', name: '舊規則' }, { id: 'shared', name: '規則' }],
      monthlySnapshots: [], reconciliations: [],
    } });
    const after = state([], { featureSettings: {
      recurringRules: [{ id: 'shared', name: '本機編輯' }],
      monthlySnapshots: [], reconciliations: [],
    } });
    const pending = updatePendingSheetChanges({}, before, after);
    const remote = state([], { featureSettings: {
      recurringRules: [
        { id: 'deleted', name: '舊規則' },
        { id: 'shared', name: 'Sheet 舊版本' },
        { id: 'remote-only', name: '另一台新增' },
      ],
      monthlySnapshots: [{ month: '2026-08', assetTotal: 100 }],
      reconciliations: [],
    } });

    expect(pending.featureUpserts.recurringRules).toEqual(['shared']);
    expect(pending.featureDeletes.recurringRules).toEqual(['deleted']);
    expect(reconcileLedgerFromSheet(after, remote, pending).featureSettings).toEqual({
      recurringRules: [{ id: 'shared', name: '本機編輯' }, { id: 'remote-only', name: '另一台新增' }],
      monthlySnapshots: remote.featureSettings.monthlySnapshots,
      reconciliations: [],
    });
  });

  it('不確認舊版 GAS 忽略的功能設定增量，且請求不會送出可覆蓋整份設定的欄位', async () => {
    const payloads = [];
    const fetchImpl = async (_url, request) => {
      payloads.push(JSON.parse(request.body));
      return { ok: true, json: async () => ({ ok: true, data: { accountCount: 0, transactionCount: 0, budgetCount: 0 } }) };
    };
    await expect(syncLedgerChangesToSheet({
      endpoint: 'https://example.com/proxy',
      proxyToken: 'token',
      state: { accounts: [], transactions: [], budgets: [], featureSettings: { recurringRules: [], monthlySnapshots: [], reconciliations: [] } },
      changes: { featureDeletes: { recurringRules: ['gone'] } },
    }, { fetchImpl })).rejects.toThrow('功能設定尚未確認上傳');
    expect(payloads[0].changes.featureSettings).toBeNull();
    expect(payloads[0].changes.featureSettingsDelta).toBeNull();
    expect(payloads[0].changes.featureDeletes.recurringRules).toEqual(['gone']);
  });

  it('只確認實際送出且仍是同一版本的交易，保留同步期間的再次編輯', () => {
    const sentState = state([{ id: 'edited', amount: 100 }, { id: 'done', amount: 50 }]);
    const currentState = state([{ id: 'edited', amount: 200 }, { id: 'done', amount: 50 }, { id: 'new', amount: 30 }]);
    const sent = { upserts: ['edited', 'done'], deletes: [] };
    const current = { upserts: ['edited', 'done', 'new'], deletes: [] };
    const remaining = acknowledgePendingSheetChanges(current, sent, sentState, currentState);

    expect(remaining.upserts).toEqual(['edited', 'new']);
    expect(current.upserts).toEqual(['edited', 'done', 'new']);
    expect(sent.upserts).toEqual(['edited', 'done']);
    expect(reconcileLedgerFromSheet(currentState, sentState, remaining).transactions).toEqual(currentState.transactions);
  });

  it('送出後刪除或還原的交易仍保留下一次同步所需的相反操作', () => {
    const sentState = state([{ id: 'removed-during-sync', amount: 10 }]);
    const currentState = state([{ id: 'restored-during-sync', amount: 20 }]);
    const sent = { upserts: ['removed-during-sync'], deletes: ['restored-during-sync', 'deleted'] };
    const current = { upserts: ['restored-during-sync'], deletes: ['removed-during-sync', 'deleted'] };

    expect(acknowledgePendingSheetChanges(current, sent, sentState, currentState)).toMatchObject({
      upserts: ['restored-during-sync'],
      deletes: ['removed-during-sync'],
    });
  });

  it('帳戶、預算與功能設定在送出後再次修改仍會保留待同步版本', () => {
    const sentState = state([], {
      accounts: [{ id: 'cash', openingBalance: 100 }, { id: 'done', openingBalance: 0 }],
      budgets: [{ category: '飲食', limit: 1000 }],
      featureSettings: { recurringRules: [{ id: 'rule', amount: 10 }] },
    });
    const currentState = state([], {
      accounts: [{ id: 'cash', openingBalance: 200 }, { id: 'done', openingBalance: 0 }],
      budgets: [{ category: '飲食', limit: 2000 }],
      featureSettings: { recurringRules: [{ id: 'rule', amount: 20 }] },
    });
    const sent = {
      accountUpserts: ['cash', 'done'], accountDeletes: ['closed'],
      budgetUpserts: ['飲食'], budgetDeletes: ['娛樂'], features: true,
    };

    expect(acknowledgePendingSheetChanges(sent, sent, sentState, currentState)).toMatchObject({
      accountUpserts: ['cash'], accountDeletes: [],
      budgetUpserts: ['飲食'], budgetDeletes: [], features: true,
    });
  });

  it('只有本機偏好不同時仍確認已送出的所有版本', () => {
    const sentState = state([{ id: 'done', amount: 10 }], {
      accounts: [{ id: 'cash', openingBalance: 100 }],
      budgets: [{ category: '飲食', limit: 1000 }],
      featureSettings: { recurringRules: [] },
    });
    const sent = { upserts: ['done'], accountUpserts: ['cash'], budgetUpserts: ['飲食'], features: true };
    const currentState = { ...sentState, preferences: { theme: 'dark' } };

    expect(hasPendingSheetChanges(acknowledgePendingSheetChanges(sent, sent, sentState, currentState))).toBe(false);
  });
});
