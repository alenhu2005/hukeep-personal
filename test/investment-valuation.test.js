import { describe, expect, it } from 'vitest';
import { calculateInvestmentValuation, investmentMarketValue } from '../src/domain/investment-valuation.js';

describe('投資市值估算', () => {
  const accounts = [
    { id: 'cash', openingBalance: 20000 },
    { id: 'investment', openingBalance: 10000 },
  ];

  it('預設以本金計入總資產，其他帳戶與收支維持原值', () => {
    expect(calculateInvestmentValuation(accounts, [
      { type: 'income', amount: 500, account: 'cash' },
      { type: 'transfer', amount: 2000, account: 'cash', toAccount: 'investment' },
      { type: 'expense', amount: 300, account: 'cash' },
    ])).toEqual({ principal: 12000, marketValue: null, totalAssets: 30200 });
  });

  it('有市值時只替換投資本金一次，允許市值為零', () => {
    expect(calculateInvestmentValuation(accounts, [], 15000)).toEqual({
      principal: 10000, marketValue: 15000, totalAssets: 35000,
    });
    expect(calculateInvestmentValuation(accounts, [], 0).totalAssets).toBe(20000);
  });

  it('拒絕負數、小數與非安全整數市值', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => calculateInvestmentValuation(accounts, [], value)).toThrow();
    }
  });

  it('以對帳日帳面本金重算基準，涵蓋後補的回溯交易', () => {
    const state = {
      accounts,
      transactions: [
        { type: 'income', amount: 100, account: 'investment', date: '2026-08-10' },
        { type: 'income', amount: 50, account: 'investment', date: '2026-08-20' },
      ],
    };
    expect(investmentMarketValue(state, {
      actualBalance: 250,
      estimatedBalance: 150,
      date: '2026-08-15',
    }, 10150)).toBe(300);
  });

  it('略過無效或負數的實際對帳餘額', () => {
    expect(investmentMarketValue({ accounts, transactions: [] }, { actualBalance: -1, date: '2026-08-15' }, 10000))
      .toBeUndefined();
    expect(investmentMarketValue({ accounts, transactions: [] }, { actualBalance: 1.5, date: '2026-08-15' }, 10000))
      .toBeUndefined();
  });
});
