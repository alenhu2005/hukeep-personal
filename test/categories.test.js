import { describe, expect, it } from 'vitest';
import {
  EXPENSE_TAXONOMY,
  INCOME_TAXONOMY,
  classifyIncomeLocally,
  classifyLocally,
  getSubcategories,
  validateClassification,
} from '../src/domain/category-taxonomy.js';

describe('階層分類 taxonomy', () => {
  it('提供個人記帳需要的詳細支出大分類與小分類', () => {
    expect(EXPENSE_TAXONOMY['飲食']).toEqual(
      expect.arrayContaining(['火鍋', '燒烤', '炸物', '甜品', '咖啡']),
    );
    expect(EXPENSE_TAXONOMY['交通']).toContain('高鐵火車');
    expect(EXPENSE_TAXONOMY['居家']).toContain('網路通訊');
    expect(EXPENSE_TAXONOMY['醫療']).toContain('藥品');
  });

  it('支出與收入 taxonomy 分開，並可取得指定大分類的小分類', () => {
    expect(Object.keys(INCOME_TAXONOMY)).toEqual(
      expect.arrayContaining([
        '薪資',
        '獎金',
        '接案',
        '投資',
        '零用與贈與',
        '中獎',
        '其他收入',
      ]),
    );
    expect(INCOME_TAXONOMY['零用與贈與']).toContain('零用錢');
    expect(INCOME_TAXONOMY['接案']).toContain('家教');
    expect(INCOME_TAXONOMY['中獎']).toContain('發票中獎');
    expect(getSubcategories('飲食')).toEqual(EXPENSE_TAXONOMY['飲食']);
    expect(getSubcategories('薪資', 'income')).toEqual(INCOME_TAXONOMY['薪資']);
    expect(getSubcategories('不存在')).toEqual([]);
  });

  it('回傳小分類副本，呼叫端無法改動共用 taxonomy', () => {
    const subcategories = getSubcategories('飲食');
    subcategories.push('測試分類');

    expect(EXPENSE_TAXONOMY['飲食']).not.toContain('測試分類');
  });
});

describe('本機收入分類', () => {
  it.each([
    ['媽媽給的零用錢', { topCategory: '零用與贈與', subcategory: '零用錢' }],
    ['收到這週家教費', { topCategory: '接案', subcategory: '家教' }],
    ['統一發票中獎', { topCategory: '中獎', subcategory: '發票中獎' }],
  ])('辨識收入來源 %#', (text, expected) => {
    expect(classifyIncomeLocally(text)).toMatchObject(expected);
  });
});

describe('本機分類', () => {
  it.each([
    [
      { merchant: '鼎王麻辣鍋', items: ['麻辣鍋', '牛肉盤'] },
      { topCategory: '飲食', subcategory: '火鍋' },
    ],
    [
      { merchant: '星巴克咖啡', items: ['大杯拿鐵'] },
      { topCategory: '飲食', subcategory: '咖啡' },
    ],
    [
      { merchant: '台灣高鐵', items: ['台北到高雄車票'] },
      { topCategory: '交通', subcategory: '高鐵火車' },
    ],
    [
      { merchant: '中華電信', items: ['光世代網路費'] },
      { topCategory: '居家', subcategory: '網路通訊' },
    ],
    [
      { merchant: '丁丁藥局', items: ['感冒藥', '退燒藥'] },
      { topCategory: '醫療', subcategory: '藥品' },
    ],
  ])('依商家與品項高信心分類 %#', (input, expected) => {
    const result = classifyLocally(input);

    expect(result).toMatchObject(expected);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('沒有明確關鍵字時回到其他支出且維持低信心', () => {
    const result = classifyLocally({ merchant: '未辨識商家', items: ['不明品項'] });

    expect(result).toMatchObject({
      topCategory: '其他',
      subcategory: '其他支出',
    });
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('AI 分類輸出驗證', () => {
  it('接受 taxonomy 內的大分類與小分類', () => {
    expect(
      validateClassification({
        topCategory: '飲食',
        subcategory: '甜品',
        confidence: 0.91,
      }),
    ).toEqual({
      topCategory: '飲食',
      subcategory: '甜品',
      confidence: 0.91,
    });
  });

  it.each([
    { topCategory: '虛構分類', subcategory: '甜品', confidence: 0.99 },
    { topCategory: '飲食', subcategory: '虛構小分類', confidence: 0.99 },
  ])('拒絕 taxonomy 外的 AI 輸出並回預設 fallback', output => {
    expect(validateClassification(output)).toEqual({
      topCategory: '其他',
      subcategory: '其他支出',
      confidence: 0,
    });
  });

  it('可使用呼叫端提供的合法 fallback', () => {
    const fallback = {
      topCategory: '退款',
      subcategory: '消費退款',
      confidence: 0.2,
    };

    expect(
      validateClassification(
        { topCategory: '飲食', subcategory: '不存在', confidence: 1 },
        { type: 'income', fallback },
      ),
    ).toEqual(fallback);
  });
});
