import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  createTransaction,
  filterTransactions,
  removeTransaction,
  updateTransaction,
} from '../src/domain/transactions.js';

const fixedOptions = {
  id: 'tx-fixed',
  now: '2026-08-28T08:00:00.000Z',
};

function expense(overrides = {}) {
  return {
    type: 'expense',
    amount: 120,
    category: '飲食',
    account: 'cash',
    date: '2026-08-28',
    note: '午餐',
    ...overrides,
  };
}

describe('createTransaction', () => {
  it('將主要名稱與補充備註分開儲存', () => {
    expect(
      createTransaction(
        expense({ name: '  鼎王麻辣鍋  ', note: '  和朋友聚餐  ' }),
        fixedOptions,
      ),
    ).toMatchObject({ name: '鼎王麻辣鍋', note: '和朋友聚餐' });
    expect(() => createTransaction(expense({ name: '   ' }), fixedOptions)).toThrow('名稱');
  });

  it('建立正規化的整數 TWD 支出且不改動輸入', () => {
    const input = expense({ category: '  飲食  ', note: '  午餐  ' });
    const result = createTransaction(input, fixedOptions);

    expect(result).toEqual({
      id: 'tx-fixed',
      type: 'expense',
      amount: 120,
      category: '飲食',
      account: 'cash',
      toAccount: null,
      date: '2026-08-28',
      note: '午餐',
      createdAt: fixedOptions.now,
      updatedAt: fixedOptions.now,
    });
    expect(input.category).toBe('  飲食  ');
  });

  it.each([0, -1, 12.5, Number.NaN])('拒絕非正整數金額 %s', amount => {
    expect(() => createTransaction(expense({ amount }), fixedOptions)).toThrow(ValidationError);
  });

  it('拒絕不存在的日期與空分類', () => {
    expect(() => createTransaction(expense({ date: '2026-02-30' }), fixedOptions)).toThrow(
      '日期',
    );
    expect(() => createTransaction(expense({ category: ' ' }), fixedOptions)).toThrow('分類');
  });

  it('轉帳要求不同目的帳戶且不保留分類', () => {
    const result = createTransaction(
      expense({ type: 'transfer', account: 'cash', toAccount: 'bank', category: '飲食' }),
      fixedOptions,
    );
    expect(result.category).toBeNull();
    expect(result.toAccount).toBe('bank');

    expect(() =>
      createTransaction(
        expense({ type: 'transfer', account: 'cash', toAccount: 'cash' }),
        fixedOptions,
      ),
    ).toThrow('目的帳戶');
  });
});

describe('交易集合操作', () => {
  const original = [
    createTransaction(expense(), fixedOptions),
    createTransaction(
      expense({ type: 'income', amount: 50000, category: '薪資', account: 'bank', note: '8 月薪資' }),
      { id: 'income-1', now: '2026-08-27T08:00:00.000Z' },
    ),
    createTransaction(expense({ amount: 80, date: '2026-07-20', note: '捷運' }), {
      id: 'old-1',
      now: '2026-07-20T08:00:00.000Z',
    }),
  ];

  it('更新時保留 id/createdAt 並回傳新陣列', () => {
    const result = updateTransaction(original, 'tx-fixed', { amount: 150, note: '晚餐' }, {
      now: '2026-08-28T09:00:00.000Z',
    });

    expect(result).not.toBe(original);
    expect(result[0]).not.toBe(original[0]);
    expect(result[0]).toMatchObject({
      id: 'tx-fixed',
      amount: 150,
      note: '晚餐',
      createdAt: fixedOptions.now,
      updatedAt: '2026-08-28T09:00:00.000Z',
    });
    expect(original[0].amount).toBe(120);
  });

  it('手動編輯匯入記錄時標記修改時間，供背景審查保留使用者選擇', () => {
    const imported = [
      createTransaction(
        expense({ source: 'ocr', sourceId: 'ocr-shot', subcategory: '咖啡' }),
        fixedOptions,
      ),
    ];
    const result = updateTransaction(imported, 'tx-fixed', { note: '自己改過的備註' }, {
      now: '2026-08-29T02:00:00.000Z',
    });

    expect(result[0]).toMatchObject({
      source: 'ocr',
      sourceId: 'ocr-shot',
      note: '自己改過的備註',
      userEditedAt: '2026-08-29T02:00:00.000Z',
    });
  });

  it('手動建立的記錄一旦修改也會鎖定，背景 AI 不得覆蓋', () => {
    const result = updateTransaction(original, 'tx-fixed', { note: '使用者最後決定' }, {
      now: '2026-08-29T03:00:00.000Z',
    });
    expect(result[0].userEditedAt).toBe('2026-08-29T03:00:00.000Z');
  });

  it('保留口語後台審查狀態與原文', () => {
    const transaction = createTransaction(
      expense({
        name: '鼎王麻辣鍋',
        amount: 1200,
        subcategory: '火鍋',
        account: 'sinopac',
        source: 'voice',
        aiStatus: 'reviewed',
        aiReviewedAt: '2026-08-29T06:01:00.000Z',
        rawTranscript: '昨天用永豐在鼎王吃麻辣鍋一千二',
      }),
      { id: 'voice:1', now: '2026-08-29T06:00:00.000Z' },
    );

    expect(transaction).toMatchObject({
      aiStatus: 'reviewed',
      aiReviewedAt: '2026-08-29T06:01:00.000Z',
      rawTranscript: '昨天用永豐在鼎王吃麻辣鍋一千二',
    });
  });

  it('找不到交易時明確失敗', () => {
    expect(() => updateTransaction(original, 'missing', { amount: 1 })).toThrow('找不到');
  });

  it('刪除時回傳新陣列且不改動原陣列', () => {
    const result = removeTransaction(original, 'tx-fixed');
    expect(result.map(item => item.id)).toEqual(['income-1', 'old-1']);
    expect(original).toHaveLength(3);
  });

  it('可依月份、類型、帳戶與關鍵字組合篩選', () => {
    expect(filterTransactions(original, { month: '2026-08' })).toHaveLength(2);
    expect(filterTransactions(original, { type: 'income' }).map(item => item.id)).toEqual([
      'income-1',
    ]);
    expect(filterTransactions(original, { account: 'bank' })).toHaveLength(1);
    expect(filterTransactions(original, { query: '薪資' })).toHaveLength(1);
    expect(filterTransactions(original, { query: '不存在' })).toEqual([]);
  });

  it('歷史搜尋也會搜尋主要名稱', () => {
    const named = [createTransaction(expense({ name: '隱藏名稱', note: '其他備註' }), fixedOptions)];
    expect(filterTransactions(named, { query: '隱藏名稱' })).toHaveLength(1);
  });
});
