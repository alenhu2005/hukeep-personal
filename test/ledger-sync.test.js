import { describe, expect, it } from 'vitest';
import { mergeLedgerStates } from '../src/domain/ledger-sync.js';

function state(transactions = [], options = {}) {
  return {
    schemaVersion: 1,
    accounts: options.accounts ?? [],
    transactions,
    budgets: options.budgets ?? [],
    preferences: options.preferences ?? { theme: 'system' },
  };
}

describe('Sheet 雙向更新合併', () => {
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
      preferences: { theme: 'dark', carrierEndpoint: 'https://example.com' },
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
    });

    const local = state([{ id: 'same', updatedAt: 'not-a-date', name: '本機' }]);
    const remote = state([{ id: 'same', updatedAt: '', name: 'Sheet' }]);
    expect(mergeLedgerStates(local, remote).transactions[0].name).toBe('本機');
  });
});
