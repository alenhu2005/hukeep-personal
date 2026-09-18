import { describe, expect, it } from 'vitest';
import {
  INVESTMENT_ACCOUNT_ID,
  INVESTMENT_OPENING_ASSET,
  migrateInvestmentAccounting,
  summarizeInvestmentFlows,
} from '../src/domain/investment-accounting.js';

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
