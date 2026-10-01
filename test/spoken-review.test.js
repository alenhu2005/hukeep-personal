import { describe, expect, it } from 'vitest';
import { parseSpokenTransactions } from '../src/domain/spoken-entry.js';
import { detectSpokenReview } from '../src/domain/spoken-review.js';

const today = '2026-08-29';

describe('多筆口語歧義檢查', () => {
  it('所有品項共用明確帳戶時可直接記帳', () => {
    const text = '咖啡 65、三明治 80 都用現金';
    expect(detectSpokenReview(text, parseSpokenTransactions(text, { today }))).toEqual({
      needsReview: false, reasons: [], itemIndexes: [],
    });
  });

  it('帳戶未說明時要求確認帳戶', () => {
    const text = '咖啡 65、三明治 80';
    expect(detectSpokenReview(text, parseSpokenTransactions(text, { today }))).toMatchObject({
      needsReview: true, reasons: ['account'], itemIndexes: [0, 1],
    });
  });

  it('多個帳戶沒有對應到各品項時要求確認', () => {
    const text = '咖啡 65、三明治 80，用現金和 LINE';
    expect(detectSpokenReview(text, parseSpokenTransactions(text, { today })).reasons).toContain('account');
  });

  it('明確指出每個品項的帳戶時可直接記帳', () => {
    const text = '咖啡 65、三明治 80，咖啡用現金，三明治用 LINE';
    expect(detectSpokenReview(text, parseSpokenTransactions(text, { today })).needsReview).toBe(false);
  });

  it('單筆解析不觸發多筆預覽', () => {
    expect(detectSpokenReview('咖啡 65 用現金', parseSpokenTransactions('咖啡 65 用現金', { today })))
      .toEqual({ needsReview: false, reasons: [], itemIndexes: [] });
  });
});
