import { describe, expect, it } from 'vitest';
import {
  INVESTMENT_ACCOUNT_ID,
  INVESTMENT_OPENING_ASSET,
  INVESTMENT_SNAPSHOT_DATE,
  migrateInvestmentAccounting,
  summarizeInvestmentFlows,
} from '../src/domain/investment-accounting.js';
import { calculateAccountBalances } from '../src/domain/insights.js';
import { normalizeLedgerState } from '../src/storage/ledger-repository.js';

describe('投資資產會計', () => {
  it('將安全的舊投資支出轉成資產移轉，並校準為目前 NT$12,891', () => {
    const original = {
      accounts: [{ id: 'sinopac', name: '永豐', icon: '永', openingBalance: 50000 }],
      transactions: [
        { id: 'etf', type: 'expense', amount: 10000, account: 'sinopac', toAccount: null, category: '投資', subcategory: 'ETF', date: '2026-08-01', name: '0050', note: '定期定額', userEditedAt: '2026-08-01T00:00:00.000Z' },
        { id: 'fee', type: 'expense', amount: 20, account: 'sinopac', toAccount: null, category: '投資', subcategory: '交易手續費', date: '2026-08-01', name: '手續費' },
        { id: 'other', type: 'expense', amount: 300, account: 'sinopac', toAccount: null, category: '投資', subcategory: '其他投資', date: '2026-08-02', name: '待確認' },
      ],
    };

    const migrated = migrateInvestmentAccounting(original);
    const investment = migrated.state.accounts.find(account => account.id === INVESTMENT_ACCOUNT_ID);

    expect(investment).toMatchObject({ name: '投資資產', openingBalance: INVESTMENT_OPENING_ASSET - 10000 });
    expect(migrated.state.transactions[0]).toMatchObject({
      id: 'etf', type: 'transfer', account: 'sinopac', toAccount: 'investment',
      category: '投資', subcategory: 'ETF', name: '0050', note: '定期定額',
      userEditedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(migrated.state.transactions[1].type).toBe('expense');
    expect(migrated.state.transactions[2].type).toBe('expense');
    expect(migrated.changedTransactionIds).toEqual(['etf']);

    expect(migrateInvestmentAccounting(migrated.state)).toEqual({
      state: migrated.state,
      changedTransactionIds: [],
      accountAdded: false,
    });
  });

  it('以固定快照校正既有錯誤負數，兩台裝置會得到相同的投資金額', () => {
    const transactions = [
      { id: 'old-buy', type: 'transfer', amount: 11538, account: 'sinopac', toAccount: 'investment', category: '投資', subcategory: 'ETF', date: '2026-09-01' },
    ];
    const deviceA = migrateInvestmentAccounting({
      accounts: [{ id: 'investment', name: '投資資產', icon: '投', openingBalance: -56337 }],
      transactions,
    }).state;
    const deviceB = migrateInvestmentAccounting({
      accounts: [{ id: 'investment', name: '投資資產', icon: '投', openingBalance: 12891 }],
      transactions,
    }).state;

    expect(INVESTMENT_SNAPSHOT_DATE).toBe('2026-09-18');
    expect(deviceA.accounts[0].openingBalance).toBe(1353);
    expect(deviceB.accounts[0].openingBalance).toBe(1353);
    expect(deviceA).toEqual(deviceB);
    expect(deviceA.accounts[0].openingBalance + transactions[0].amount).toBe(INVESTMENT_OPENING_ASSET);
  });

  it('快照日後的新買入才會增加投資資產，不會被基準值吃掉', () => {
    const migrated = migrateInvestmentAccounting({
      accounts: [{ id: 'investment', name: '投資資產', icon: '投', openingBalance: -99999 }],
      transactions: [
        { id: 'old-buy', type: 'transfer', amount: 11538, account: 'sinopac', toAccount: 'investment', category: '投資', subcategory: 'ETF', date: '2026-09-01' },
        { id: 'new-buy', type: 'transfer', amount: 1000, account: 'sinopac', toAccount: 'investment', category: '投資', subcategory: '股票', date: '2026-09-19' },
      ],
    }).state;
    const investment = migrated.accounts.find(account => account.id === INVESTMENT_ACCOUNT_ID);
    const balance = investment.openingBalance + 11538 + 1000;

    expect(balance).toBe(13891);
    expect(migrateInvestmentAccounting(migrated).state).toEqual(migrated);
  });

  it('不同裝置的舊快取經正規化後會收斂為相同餘額', () => {
    const transactions = [
      { id: 'buy', type: 'transfer', amount: 11538, fee: 0, account: 'sinopac', toAccount: 'investment', category: '投資', subcategory: 'ETF', date: '2026-09-01', name: '0050' },
    ];
    const baseAccounts = [
      { id: 'sinopac', name: '永豐', icon: '永', openingBalance: 20000 },
      { id: 'investment', name: '投資資產', icon: '投', openingBalance: 0 },
    ];
    const deviceA = normalizeLedgerState({ accounts: baseAccounts, transactions });
    const deviceB = normalizeLedgerState({
      accounts: baseAccounts.map(account => account.id === 'investment'
        ? { ...account, openingBalance: -56337 }
        : account),
      transactions,
    });

    expect(calculateAccountBalances(deviceA.accounts, deviceA.transactions)).toEqual(
      calculateAccountBalances(deviceB.accounts, deviceB.transactions),
    );
    expect(calculateAccountBalances(deviceA.accounts, deviceA.transactions)).toContainEqual({
      id: 'investment',
      balance: INVESTMENT_OPENING_ASSET,
    });
  });

  it('彙總投入、領回、淨投入與細分類，不把手續費當本金', () => {
    const summary = summarizeInvestmentFlows([
      { type: 'transfer', amount: 10000, fee: 20, account: 'sinopac', toAccount: 'investment', category: '投資', subcategory: 'ETF', date: '2026-09-01' },
      { type: 'transfer', amount: 3000, account: 'investment', toAccount: 'bot', category: '投資', subcategory: '股票', date: '2026-09-02' },
      { type: 'expense', amount: 500, account: 'cash', category: '投資', subcategory: '投資課程', date: '2026-09-03' },
    ]);

    expect(summary).toEqual({
      contributed: 10000,
      withdrawn: 3000,
      net: 7000,
      count: 2,
      bySubcategory: { ETF: 10000, '股票': -3000 },
    });
  });
});
