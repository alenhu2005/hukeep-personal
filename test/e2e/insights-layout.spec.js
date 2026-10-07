import { expect, test } from '@playwright/test';
import { createEmptyState, STORAGE_KEY } from '../../src/storage/ledger-repository.js';
import { createTransaction } from '../../src/domain/transactions.js';

const now = '2026-10-18T04:00:00Z';

function reviewState() {
  const state = createEmptyState();
  const add = (id, values) => createTransaction({
    type: 'expense', amount: 100, category: '飲食', subcategory: '正餐',
    account: 'cash', date: '2026-10-18', name: id, ...values,
  }, { id, now });
  state.transactions = [
    ...Array.from({ length: 18 }, (_, i) => add(`meal-${i}`, {
      name: '午餐', date: `2026-10-${String(i + 1).padStart(2, '0')}`, amount: 120 + i * 5,
    })),
    add('coffee', { name: '拿鐵與下午茶', amount: 160, subcategory: '咖啡', account: 'line' }),
    add('tea', { name: '無糖青茶', amount: 45, subcategory: '飲料' }),
    add('fees', { type: 'transfer', category: '投資', subcategory: 'ETF', account: 'sinopac', toAccount: 'investment', amount: 10000, fee: 20, name: '0050 買入' }),
    add('sale', { type: 'transfer', category: '投資', subcategory: '股票', account: 'investment', toAccount: 'sinopac', amount: 3000, name: '股票賣出' }),
    add('dividend', { type: 'income', category: '投資', subcategory: '股息', amount: 360, name: '股票股息' }),
    add('salary', { type: 'income', category: '薪資', subcategory: '正職薪資', amount: 32000, name: '十月薪資', date: '2026-10-05' }),
    add('tutor', { type: 'income', category: '接案', subcategory: '家教', amount: 2400, name: '數學家教' }),
    add('travel', { category: '交通', subcategory: '大眾運輸', amount: 1280, name: '通勤月票' }),
    add('rent', { category: '居家', subcategory: '房租', amount: 12500, name: '房租', date: '2026-10-09' }),
    add('book', { category: '學習', subcategory: '書籍', amount: 620, name: '程式設計書籍' }),
    add('shopping', { category: '購物', subcategory: '日用品', amount: 450, name: '生活用品' }),
    add('film', { category: '娛樂', subcategory: '電影', amount: 300, name: '電影' }),
    add('old-meal', { date: '2026-09-18', amount: 1200, name: '前月餐費' }),
  ];
  state.budgets = [{ category: '飲食', limit: 8000 }];
  return state;
}

for (const [width, theme] of [[360, 'dark'], [401, 'light'], [768, 'light'], [1440, 'light']]) {
  test(`${width}px ${theme} 趨勢版面、分類與日期操作`, async ({ page }) => {
    await page.setViewportSize({ width, height: 880 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.clock.setFixedTime(new Date(now));
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: STORAGE_KEY, value: reviewState(),
    });
    await page.route('https://**', route => route.abort());
    await page.goto('./#insights');
    const shell = page.locator('.daily-analysis-shell');
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = async name => {
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: `test-results/trends-${width}-${theme}-${name}.png` });
    };
    await expect(page.locator('#trend-chart')).toBeVisible();
    await expect(page.locator('.analysis-history-section')).toHaveCount(0);
    await expect(shell.getByText('顏色深淺說明')).toHaveCount(0);
    expect(await page.locator('.analysis-cal-cell').first().evaluate(el => el.getBoundingClientRect().height)).toBe(35);
    await expect(page.locator('.analysis-calendar-footer')).toHaveCount(0);
    expect(await page.locator('.analysis-metric-strip strong').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(19);
    const contrast = await page.locator('.analysis-cal-cell').evaluateAll(cells => {
      const ctx = document.createElement('canvas').getContext('2d');
      const luminance = color => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const channels = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => {
          const c = v / 255;
          return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return Math.min(...cells.map(cell => {
        const style = getComputedStyle(cell);
        const text = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
      }));
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await noOverflow();
    await screenshot('overview');

    await page.locator('[data-insight-section="expense"]').click();
    await expect(page.locator('.analysis-upgrade-value.current')).toHaveCount(0);
    await screenshot('expense');
    await page.locator('[data-insight-category="飲食"]').click();
    await expect(page.locator('.analysis-focus h2')).toHaveText('飲食');
    await page.locator('.analysis-focus').screenshot({ path: `test-results/trends-${width}-${theme}-category-card.png` });
    await page.locator('.analysis-disclosure').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
    const overflowingCharts = await page.locator('.analysis-time-bars, .analysis-upgrade-paired, .analysis-upgrade-stacks, .analysis-upgrade-budget-chart')
      .evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className));
    expect(overflowingCharts).toEqual([]);
    await noOverflow();
    await page.locator('.analysis-upgrade-paired').first().screenshot({ path: `test-results/trends-${width}-${theme}-comparison-chart.png` });
    await page.locator('.analysis-disclosure').evaluateAll(elements => elements.forEach(element => { element.open = false; }));
    await expect(page.locator('[data-analysis-disclosure="expense-飲食--comparison"]')).not.toHaveAttribute('open');
    await page.locator('[data-insight-subcategory="咖啡"]').click();
    await expect(page.locator('.analysis-focus h2')).toHaveText('咖啡');
    await expect(page.getByRole('button', { name: '查看 拿鐵與下午茶 詳情' })).toBeVisible();
    await noOverflow();
    await screenshot('subcategory');
    await page.locator('.analysis-focus').screenshot({ path: `test-results/trends-${width}-${theme}-subcategory-card.png` });
    await page.getByRole('button', { name: '返回大分類', exact: true }).click();
    await expect(page.locator('.analysis-focus h2')).toHaveText('飲食');

    await page.locator('[data-insight-section="income"]').click();
    await page.locator('[data-insight-category="接案"]').click();
    await expect(page.getByRole('region', { name: '接案小分類圖表', exact: true })).toContainText('家教');
    await noOverflow();
    await screenshot('income');
    await page.locator('[data-insight-section="investment"]').click();
    await expect(page.locator('.investment-flow-row')).toHaveCount(2);
    await noOverflow();
    await screenshot('investment');
    expect(await page.locator('.analysis-investment-series').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.locator('.investment-analysis').screenshot({ path: `test-results/trends-${width}-${theme}-investment-card.png` });

    await page.locator('[data-insight-period="week"]').click();
    await expect(page.locator('.analysis-week-cell')).toHaveCount(7);
    expect(await page.locator('.analysis-week-cell').first().evaluate(el => el.getBoundingClientRect().height)).toBe(49);
    await page.locator('[data-insight-date="2026-10-18"]').click();
    expect(await page.locator('#trend-chart').evaluate(el => el.nextElementSibling.classList.contains('analysis-history-section'))).toBe(true);
    await expect(page.locator('.analysis-history-section')).toContainText('拿鐵與下午茶');
    await noOverflow();
    await screenshot('selected-day');
    await page.locator('[data-insight-period="year"]').click();
    await expect(page.locator('.analysis-history-section')).toHaveCount(0);
    await expect(page.locator('.analysis-year-mo')).toHaveCount(12);
    expect(await page.locator('.analysis-year-months').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width <= 360 ? 3 : 4);
    await screenshot('year');
    await page.locator('[data-insight-month="2026-10"]').click();
    await expect(page.locator('.analysis-cal-cell')).toHaveCount(31);
    await expect(page.locator('.analysis-history-section')).toHaveCount(0);
    await noOverflow();
  });
}
