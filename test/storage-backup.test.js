import { describe, expect, it } from 'vitest';
import { parseBackup, serializeBackup, transactionsToCsv } from '../src/backup.js';
import {
  STORAGE_KEY,
  createEmptyState,
  createLedgerRepository,
} from '../src/storage/ledger-repository.js';

function createMemoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

describe('ledger repository', () => {
  it('使用獨立 namespace 並為首次使用建立預設狀態', () => {
    expect(STORAGE_KEY).toBe('hukeep_personal_state_v1');
    const state = createLedgerRepository(createMemoryStorage()).load();
    expect(state.schemaVersion).toBe(1);
    expect(state.transactions).toEqual([]);
    expect(state.budgets).toEqual([]);
    expect(state.accounts.map(account => account.id)).toEqual([
      'cash',
      'line',
      'sinopac',
      'bot',
      'post',
    ]);
  });

  it('儲存與讀取後保留內容但不共用物件參考', () => {
    const storage = createMemoryStorage();
    const repository = createLedgerRepository(storage);
    const state = createEmptyState();
    state.transactions = [
      {
        id: '1',
        type: 'expense',
        name: '午餐',
        amount: 10,
        category: '飲食',
        account: 'cash',
        toAccount: null,
        date: '2026-08-28',
        note: '早餐',
        createdAt: '2026-08-28T08:00:00.000Z',
        updatedAt: '2026-08-28T08:00:00.000Z',
      },
    ];
    repository.save(state);

    const loaded = repository.load();
    expect(loaded.transactions).toEqual(state.transactions);
    expect(loaded).not.toBe(state);
    loaded.transactions.push({ id: '2' });
    expect(repository.load().transactions).toHaveLength(1);
  });

  it('遇到壞掉的 JSON 時安全回復空狀態', () => {
    const repository = createLedgerRepository(createMemoryStorage({ [STORAGE_KEY]: '{bad' }));
    expect(repository.load()).toEqual(createEmptyState());
  });

  it('把舊版通用銀行與信用卡轉成客製帳戶且保留紀錄', () => {
    const legacy = {
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '錢', openingBalance: 100 },
        { id: 'bank', name: '銀行', icon: '銀', openingBalance: 200 },
        { id: 'card', name: '信用卡', icon: '卡', openingBalance: -300 },
      ],
      transactions: [
        {
          id: 'legacy-income',
          type: 'income',
          amount: 1000,
          category: '薪資',
          account: 'bank',
          date: '2026-08-28',
          note: '薪水',
          createdAt: '2026-08-28T08:00:00.000Z',
          updatedAt: '2026-08-28T08:00:00.000Z',
        },
        {
          id: 'legacy-expense',
          type: 'expense',
          amount: 200,
          category: '飲食',
          account: 'card',
          date: '2026-08-28',
          note: '晚餐',
          createdAt: '2026-08-28T09:00:00.000Z',
          updatedAt: '2026-08-28T09:00:00.000Z',
        },
      ],
      budgets: [],
      preferences: { theme: 'system' },
    };
    const state = createLedgerRepository(
      createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) }),
    ).load();

    expect(state.accounts.map(account => account.id)).toEqual([
      'cash',
      'line',
      'sinopac',
      'bot',
      'post',
    ]);
    expect(state.accounts.find(account => account.id === 'bot').openingBalance).toBe(200);
    expect(state.accounts.find(account => account.id === 'sinopac').openingBalance).toBe(-300);
    expect(state.transactions.map(transaction => transaction.account)).toEqual(['bot', 'sinopac']);
  });

  it('不保存代理憑證，升級時移除載具偏好並保留安全的 Sheet 代理網址', () => {
    const storage = createMemoryStorage();
    const repository = createLedgerRepository(storage);
    const state = createEmptyState();
    state.preferences = {
      theme: 'dark',
      carrierEndpoint: 'https://example.com/old-proxy',
      carrierCardNo: '/ABC+123',
      carrierBound: true,
      carrierSyncStartDate: '2026-08-01',
      proxyToken: 'must-not-persist',
      cardEncrypt: 'must-not-persist',
    };

    expect(repository.save(state).preferences).toEqual({
      theme: 'dark',
      proxyEndpoint: 'https://example.com/old-proxy',
    });
  });

  it('只接受 HTTPS 或本機 HTTP 的 Sheet 代理網址', () => {
    const repository = createLedgerRepository(createMemoryStorage());
    const localState = createEmptyState();
    localState.preferences = { theme: 'light', proxyEndpoint: 'http://localhost:3000/sync' };
    const unsafeState = createEmptyState();
    unsafeState.preferences = { theme: 'light', proxyEndpoint: 'http://example.com/sync' };

    expect(repository.save(localState).preferences).toEqual({
      theme: 'light',
      proxyEndpoint: 'http://localhost:3000/sync',
    });
    expect(repository.save(unsafeState).preferences).toEqual({ theme: 'light' });
  });

  it('載入備份或 localStorage 時會過濾壞掉的資料列', () => {
    const corruptedState = {
      schemaVersion: 999,
      accounts: [
        {
          id: 'cash',
          name: '現金',
          icon: '錢',
          openingBalance: 100,
        },
        {
          id: '',
          name: '壞資料',
          icon: 'X',
          openingBalance: 0,
        },
      ],
      transactions: [
        {
          id: 'valid-expense',
          type: 'expense',
          amount: 88,
          category: '飲食',
          account: 'cash',
          date: '2026-08-28',
          note: '早餐',
          createdAt: '2026-08-28T08:00:00.000Z',
          updatedAt: '2026-08-28T08:00:00.000Z',
        },
        {
          id: 'broken-expense',
          type: 'expense',
          amount: -1,
          category: '',
          account: 'cash',
          date: '2026-02-30',
        },
      ],
      budgets: [
        { category: '飲食', limit: 3000 },
        { category: '', limit: 1000 },
        { category: '娛樂', limit: 0 },
      ],
      preferences: {
        theme: 'midnight',
      },
    };

    const repository = createLedgerRepository(
      createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(corruptedState) }),
    );

    expect(repository.load()).toEqual({
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '錢', openingBalance: 100 },
      ],
      transactions: [
        {
          id: 'valid-expense',
          type: 'expense',
          amount: 88,
          category: '飲食',
          account: 'cash',
          toAccount: null,
          date: '2026-08-28',
          note: '早餐',
          createdAt: '2026-08-28T08:00:00.000Z',
          updatedAt: '2026-08-28T08:00:00.000Z',
        },
      ],
      budgets: [{ category: '飲食', limit: 3000 }],
      preferences: { theme: 'system' },
      featureSettings: { recurringRules: [], monthlySnapshots: [], reconciliations: [] },
    });
  });

  it('清除只移除個人記帳 key', () => {
    const storage = createMemoryStorage({ [STORAGE_KEY]: '{}', other: 'keep' });
    createLedgerRepository(storage).clear();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.getItem('other')).toBe('keep');
  });
});

describe('備份', () => {
  const state = {
    ...createEmptyState(),
    transactions: [
      {
        id: '1',
        type: 'expense',
        name: '午餐',
        amount: 120,
        category: '飲食',
        account: 'cash',
        toAccount: null,
        date: '2026-08-28',
        note: '=SUM(1,2) 「午餐」',
        createdAt: '2026-08-28T08:00:00.000Z',
        updatedAt: '2026-08-28T08:00:00.000Z',
      },
    ],
  };

  it('JSON 可完整往返並附帶 app/schema 識別', () => {
    const text = serializeBackup(state, { now: '2026-08-28T10:00:00.000Z' });
    const envelope = JSON.parse(text);
    expect(envelope).toMatchObject({
      app: 'hukeep-personal',
      schemaVersion: 1,
      exportedAt: '2026-08-28T10:00:00.000Z',
    });
    expect(parseBackup(text)).toEqual(state);
  });

  it('拒絕其他 app、錯誤 schema 與非 JSON', () => {
    expect(() => parseBackup('{}')).toThrow('備份');
    expect(() => parseBackup(JSON.stringify({ app: 'other', schemaVersion: 1 }))).toThrow('備份');
    expect(() => parseBackup('{oops')).toThrow('備份');
  });

  it('還原時只保留可用資料並重設不支援的偏好值', () => {
    const text = JSON.stringify({
      app: 'hukeep-personal',
      schemaVersion: 1,
      exportedAt: '2026-08-28T10:00:00.000Z',
      accounts: [
        { id: 'cash', name: '現金', icon: '錢', openingBalance: 50 },
        { id: 'card" onclick="alert(1)', name: '<img src=x>', icon: '卡', openingBalance: 'x' },
      ],
      transactions: [
        {
          id: 'keep-me',
          type: 'income',
          amount: 500,
          category: '薪資',
          account: 'cash',
          date: '2026-08-28',
          note: '薪水',
          createdAt: '2026-08-28T08:00:00.000Z',
          updatedAt: '2026-08-28T08:00:00.000Z',
        },
        {
          id: '',
          type: 'expense',
          amount: 120,
          category: '飲食',
          account: 'cash',
          date: '2026-08-28',
        },
      ],
      budgets: [{ category: '娛樂', limit: 2000 }],
      preferences: { theme: 'twilight' },
    });

    expect(parseBackup(text)).toEqual({
      schemaVersion: 1,
      accounts: [
        { id: 'cash', name: '現金', icon: '錢', openingBalance: 50 },
      ],
      transactions: [
        {
          id: 'keep-me',
          type: 'income',
          amount: 500,
          category: '薪資',
          account: 'cash',
          toAccount: null,
          date: '2026-08-28',
          note: '薪水',
          createdAt: '2026-08-28T08:00:00.000Z',
          updatedAt: '2026-08-28T08:00:00.000Z',
        },
      ],
      budgets: [{ category: '娛樂', limit: 2000 }],
      preferences: { theme: 'system' },
      featureSettings: { recurringRules: [], monthlySnapshots: [], reconciliations: [] },
    });
  });

  it('CSV 會處理逗號、引號與公式注入', () => {
    const csv = transactionsToCsv(state.transactions);
    expect(csv).toContain('類型,名稱,金額,手續費,分類,帳戶,目的帳戶,日期,備註');
    expect(csv).toContain('expense,午餐,120');
    expect(csv).toContain("\"'=SUM(1,2) 「午餐」\"");
  });
});
