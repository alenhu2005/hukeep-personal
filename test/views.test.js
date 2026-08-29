import { describe, expect, it } from 'vitest';
import { transactionRows } from '../src/views.js';

describe('交易列表', () => {
  it('以名稱為主文字，備註只放在次要資訊並安全跳脫', () => {
    const html = transactionRows(
      [
        {
          id: 'tx-1',
          type: 'expense',
          amount: 180,
          category: '飲食',
          subcategory: '咖啡',
          account: 'line',
          toAccount: null,
          date: '2026-08-29',
          name: '<b>星巴克</b>',
          note: '和朋友聊天',
        },
      ],
      [{ id: 'line', name: 'LINE' }],
    );
    expect(html).toContain('<strong>&lt;b&gt;星巴克&lt;/b&gt;</strong>');
    expect(html).toContain('和朋友聊天');
    expect(html).not.toContain('<strong>和朋友聊天</strong>');
    expect(html).not.toContain('<b>星巴克</b>');
  });
});
