import { describe, expect, it } from 'vitest';
import { reconciliationAdjustmentId, reconciliationAdjustmentNote, reconciliationAdjustmentStatus } from '../src/domain/reconciliation.js';

describe('對帳調整', () => {
  const item = { id: 'statement', accountId: 'cash', actualBalance: 70, date: '2026-09-10' };
  const state = { accounts: [{ id: 'cash', openingBalance: 80 }], transactions: [] };
  const correction = { id: 'reconcile-adjust:statement', type: 'expense', source: 'manual',
    category: '帳務調整', amount: 10, account: 'cash', date: item.date };

  it('歷史交易變動後允許重新計算同一筆調整，不把未來交易算入', () => {
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction] }, item))
      .toMatchObject({ difference: -10, corrected: true });
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction,
      { type: 'income', amount: 20, account: 'cash', date: '2026-09-01' },
      { type: 'income', amount: 100, account: 'cash', date: '2026-09-11' },
    ] }, item)).toMatchObject({ difference: -30, corrected: false, adjustment: correction });
  });

  it('長 ID 使用穩定且不被截斷的 SHA-256 ID，完整原 ID 留在關聯備註', async () => {
    const longId = 'a'.repeat(80);
    const txId = await reconciliationAdjustmentId(longId);
    expect(txId.length).toBeLessThanOrEqual(80);
    expect(await reconciliationAdjustmentId(longId)).toBe(txId);
    expect(await reconciliationAdjustmentId(`${'a'.repeat(79)}b`)).not.toBe(txId);
    const reconciliation = { ...item, id: longId };
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [{ ...correction,
      id: txId, note: reconciliationAdjustmentNote(reconciliation),
    }] }, reconciliation)).toMatchObject({ corrected: true });
  });

  it('舊版重複調整不會被誤認為已正確調整', () => {
    expect(reconciliationAdjustmentStatus({ ...state, transactions: [correction, correction] }, item))
      .toMatchObject({ estimatedBalance: 80, difference: -10, corrected: false });
  });
});
