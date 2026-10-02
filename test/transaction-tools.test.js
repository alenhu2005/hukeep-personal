import { describe, expect, it } from 'vitest';
import { calculateAccountBalances, expenseAmount, incomeAmount, summarizeMonth } from '../src/domain/insights.js';
import { bulkUpdateTransactions, linkRefund } from '../src/domain/transaction-tools.js';
import { createTransaction, normalizeStoredTransaction, updateTransaction } from '../src/domain/transactions.js';

const accounts = [{ id: 'cash' }, { id: 'bank' }];

function expense(id, amount = 200, overrides = {}) {
  return createTransaction({
    type: 'expense', amount, category: '飲食', subcategory: '便當', account: 'cash',
    date: '2026-09-01', ...overrides,
  }, { id, now: '2026-09-01T00:00:00.000Z' });
}

function income(id, amount, overrides = {}) {
  return createTransaction({
    type: 'income', amount, category: '退款與理賠', account: 'cash',
    date: '2026-09-02', ...overrides,
  }, { id, now: '2026-09-02T00:00:00.000Z' });
}

describe('退款連結', () => {
  it('退款抵減支出摘要但仍增加實際帳戶餘額', () => {
    const transactions = [expense('purchase'), income('refund', 50)];
    const linked = linkRefund(transactions, 'refund', 'purchase');

    expect(linked[1]).toMatchObject({ refundOf: 'purchase', category: '飲食', subcategory: '便當' });
    expect(incomeAmount(linked[1])).toBe(0);
    expect(expenseAmount(linked[1])).toBe(-50);
    expect(summarizeMonth(linked, '2026-09')).toMatchObject({
      income: 0, expense: 150, balance: -150, byCategory: { '飲食': 150 },
    });
    expect(calculateAccountBalances([{ id: 'cash', openingBalance: 1000 }], linked)).toEqual([
      { id: 'cash', balance: 850 },
    ]);
  });

  it('依退款日期計入當月支出', () => {
    const linked = linkRefund([
      expense('purchase', 200, { date: '2026-08-31' }),
      income('refund', 50),
    ], 'refund', 'purchase');

    expect(summarizeMonth(linked, '2026-08').expense).toBe(200);
    expect(summarizeMonth(linked, '2026-09')).toMatchObject({
      income: 0, expense: -50, balance: 50, byCategory: { '飲食': -50 },
    });
  });

  it('拒絕超過原支出剩餘金額的退款，且保留原交易陣列', () => {
    const transactions = [expense('purchase'), income('refund-1', 50, { refundOf: 'purchase' }), income('refund-2', 151)];

    expect(() => linkRefund(transactions, 'refund-2', 'purchase')).toThrow('超過');
    expect(transactions[2]).not.toHaveProperty('refundOf');
  });

  it('取消連結會清除參照並還原一般退款分類', () => {
    const linked = linkRefund([expense('purchase'), income('refund', 50)], 'refund', 'purchase');
    const unlinked = linkRefund(linked, 'refund', '');

    expect(unlinked[1]).not.toHaveProperty('refundOf');
    expect(unlinked[1]).toMatchObject({ category: '退款與理賠', subcategory: '消費退款' });
    expect(incomeAmount(unlinked[1])).toBe(50);
  });

  it('限制後續退款與原支出金額，並同步原支出的分類到退款', () => {
    const linked = linkRefund([expense('purchase'), income('refund', 50)], 'refund', 'purchase');

    expect(() => updateTransaction(linked, 'refund', { amount: 201 })).toThrow('超過');
    expect(() => updateTransaction(linked, 'purchase', { amount: 49 })).toThrow('低於已退款');
    expect(() => updateTransaction(linked, 'purchase', { date: '2026-09-03' })).toThrow('晚於退款');

    const recategorized = updateTransaction(linked, 'purchase', {
      amount: 150, category: '居家', subcategory: '房租',
    });
    expect(recategorized.find(transaction => transaction.id === 'refund')).toMatchObject({
      refundOf: 'purchase', category: '居家', subcategory: '房租',
    });
  });

  it('正規化時拒絕自我連結與非收入退款，並在一般更新中保留連結', () => {
    expect(normalizeStoredTransaction({
      id: 'same', type: 'income', amount: 1, category: '飲食', account: 'cash', date: '2026-09-01', refundOf: 'same',
    })).toBeNull();
    expect(normalizeStoredTransaction({
      ...expense('expense-refund'), refundOf: 'purchase',
    })).toBeNull();

    const linked = linkRefund([expense('purchase'), income('refund', 50)], 'refund', 'purchase');
    expect(updateTransaction(linked, 'refund', { note: '已入帳' })[1]).toMatchObject({
      refundOf: 'purchase', note: '已入帳',
    });
    expect(() => updateTransaction(linked, 'refund', {
      category: '居家', subcategory: '房租',
    })).toThrow('退款分類需與原支出一致');
    expect(() => updateTransaction(linked, 'refund', { type: 'expense' })).toThrow('退款必須是收入');
  });
});

describe('批次更新', () => {
  it('拒絕讓轉帳來源與目的帳戶相同，且不修改原資料', () => {
    const transfer = createTransaction({
      type: 'transfer', amount: 100, account: 'cash', toAccount: 'bank', date: '2026-09-01',
    }, { id: 'transfer' });
    const transactions = [transfer];

    expect(() => bulkUpdateTransactions(transactions, ['transfer'], { toAccount: 'cash' }, accounts))
      .toThrow('不同的目的帳戶');
    expect(transactions[0].toAccount).toBe('bank');
  });

  it('驗證所有選取交易後才回傳批次結果', () => {
    const transactions = [expense('valid'), income('other', 10)];

    expect(() => bulkUpdateTransactions(transactions, ['valid', 'other'], { account: 'missing' }, accounts))
      .toThrow('有效帳戶');
    expect(transactions.map(transaction => transaction.account)).toEqual(['cash', 'cash']);
  });

  it('拒絕未知分類，且保留批次輸入', () => {
    const transactions = [expense('one'), expense('two')];

    expect(() => bulkUpdateTransactions(transactions, ['one', 'two'], { category: '未知' }, accounts))
      .toThrow('分類不正確');
    expect(transactions.map(transaction => transaction.category)).toEqual(['飲食', '飲食']);
  });
});
