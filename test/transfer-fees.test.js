import { describe, expect, it } from 'vitest';
import { transferAmounts } from '../src/domain/transfer-fees.js';

describe('transferAmounts', () => {
  it('applies included fees, additional fees, and legacy additional defaults', () => {
    expect(transferAmounts({ amount: 10000, fee: 12, feeMode: 'included' }))
      .toEqual({ debit: 10000, credit: 9988, fee: 12 });
    expect(transferAmounts({ amount: 10000, fee: 12, feeMode: 'additional' }))
      .toEqual({ debit: 10012, credit: 10000, fee: 12 });
    expect(transferAmounts({ amount: 10000, fee: 12 }))
      .toEqual({ debit: 10012, credit: 10000, fee: 12 });
  });
});
