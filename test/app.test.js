import { describe, expect, it } from 'vitest';
import { renderAccountButtons, renderAccountOptions } from '../src/app.js';

describe('renderAccountOptions', () => {
  it('會跳脫帳戶 id 與名稱，避免把匯入資料直接插入 DOM', () => {
    const html = renderAccountOptions(
      [
        {
          id: 'cash" selected="selected',
          name: '<img src=x onerror=alert(1)>',
        },
        {
          id: 'bank',
          name: '銀行',
        },
      ],
      'bank',
      'cash" selected="selected',
    );

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('value="cash&quot; selected=&quot;selected"');
    expect(html).toContain('value="bank" selected');
    expect(html).toContain('disabled');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('renderAccountButtons', () => {
  it('以可存取按鈕呈現帳戶並跳脫匯入內容', () => {
    const html = renderAccountButtons(
      [
        { id: 'line', name: 'LINE', icon: 'L' },
        { id: 'bad" onclick="alert(1)', name: '<img src=x>', icon: '<' },
      ],
      'line',
      'bad" onclick="alert(1)',
      'transaction-account',
    );

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-account-value="line"');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('disabled');
    expect(html).not.toContain('<img src=x>');
  });
});
