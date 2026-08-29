import { describe, expect, it } from 'vitest';
import { updateOpeningBalances } from '../src/domain/accounts.js';

const accounts = [
  { id: 'cash', name: '現金', icon: '現', openingBalance: 0 },
  { id: 'sinopac', name: '永豐', icon: '永', openingBalance: -500 },
];

describe('帳戶初始金額', () => {
  it('允許正數、零與負數，並且不修改原帳戶物件', () => {
    const next = updateOpeningBalances(accounts, { cash: '12000', sinopac: '-1800' });

    expect(next.map(account => account.openingBalance)).toEqual([12000, -1800]);
    expect(next).not.toBe(accounts);
    expect(next[0]).not.toBe(accounts[0]);
    expect(accounts.map(account => account.openingBalance)).toEqual([0, -500]);
  });

  it('拒絕小數、空白、超過安全上限或不完整的輸入', () => {
    expect(() => updateOpeningBalances(accounts, { cash: '1.5', sinopac: '0' })).toThrow(
      '現金',
    );
    expect(() => updateOpeningBalances(accounts, { cash: '', sinopac: '0' })).toThrow('現金');
    expect(() =>
      updateOpeningBalances(accounts, { cash: '1000000000001', sinopac: '0' }),
    ).toThrow('現金');
    expect(() => updateOpeningBalances(accounts, { cash: '0' })).toThrow('永豐');
  });
});
