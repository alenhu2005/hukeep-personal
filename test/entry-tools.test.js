import { describe, expect, it } from 'vitest';
import {
  applyCategoryRules,
  clearEntryDraft,
  matchCategoryRule,
  normalizeCategoryRule,
  normalizeEntryTemplate,
  readEntryDraft,
  saveEntryDraft,
} from '../src/domain/entry-tools.js';

const now = '2026-10-02T05:00:00.000Z';

function template(overrides = {}) {
  return {
    id: 'tpl-1',
    label: '午餐',
    name: '便當',
    type: 'expense',
    amount: 120,
    account: 'cash',
    category: '飲食',
    subcategory: '便當',
    ...overrides,
  };
}

function categoryRule(overrides = {}) {
  return {
    id: 'rule-1',
    match: '全聯',
    type: 'expense',
    category: '飲食',
    subcategory: '生鮮食材',
    ...overrides,
  };
}

describe('entry templates', () => {
  it('normalizes a safe manual-entry template', () => {
    expect(normalizeEntryTemplate(template({ label: ' 午餐 ', account: ' cash ' }), { now })).toEqual({
      id: 'tpl-1',
      label: '午餐',
      name: '便當',
      type: 'expense',
      amount: 120,
      account: 'cash',
      toAccount: null,
      category: '飲食',
      subcategory: '便當',
      note: '',
      fee: 0,
      feeMode: null,
      createdAt: now,
    });
  });

  it.each([
    { type: 'unknown' },
    { amount: 0 },
    { amount: -1 },
    { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { amount: true },
    { account: 'bad/account' },
    { account: 'missing' },
    { category: '不存在' },
    { subcategory: '不是這個分類' },
  ])('rejects invalid template values %#', invalid => {
    expect(normalizeEntryTemplate(template(invalid), { accounts: [{ id: 'cash' }], now })).toBeNull();
  });

  it('requires distinct safe transfer accounts and a valid fee mode', () => {
    const transfer = template({ type: 'transfer', account: 'cash', toAccount: 'bank', category: undefined });
    expect(normalizeEntryTemplate(transfer, { now })).toMatchObject({
      type: 'transfer',
      account: 'cash',
      toAccount: 'bank',
      category: null,
      fee: 0,
      feeMode: 'additional',
    });
    expect(normalizeEntryTemplate({ ...transfer, toAccount: 'cash' }, { now })).toBeNull();
    expect(normalizeEntryTemplate({ ...transfer, feeMode: 'unknown' }, { now })).toBeNull();
    expect(normalizeEntryTemplate({ ...transfer, fee: 120, feeMode: 'included' }, { now })).toBeNull();
  });

  it('keeps investment classification only on investment transfers', () => {
    const result = normalizeEntryTemplate(template({
      type: 'transfer',
      account: 'sinopac',
      toAccount: 'investment',
      subcategory: 'ETF',
    }), { now });
    expect(result).toMatchObject({ category: '投資', subcategory: 'ETF' });
  });

  it('uses stable empty creation timestamps when input has none', () => {
    const input = template();
    const first = normalizeEntryTemplate(input);
    expect(normalizeEntryTemplate(input)).toEqual(first);
    expect(first.createdAt).toBe('');
  });
});

describe('personal category rules', () => {
  it('normalizes only valid exact-match category assignments', () => {
    expect(normalizeCategoryRule(categoryRule({ match: ' 全聯 ' }), now)).toEqual({
      id: 'rule-1',
      match: '全聯',
      type: 'expense',
      category: '飲食',
      subcategory: '生鮮食材',
      createdAt: now,
    });
    expect(normalizeCategoryRule(categoryRule({ subcategory: '不合法' }), now)).toBeNull();
    expect(normalizeCategoryRule(categoryRule({ type: 'transfer' }), now)).toBeNull();
  });

  it('keeps missing timestamps stable and ranks them below dated rules', () => {
    const undated = categoryRule({ id: 'rule-undated' });
    const dated = categoryRule({ id: 'rule-dated', subcategory: '便當', createdAt: '2026-09-01T00:00:00.000Z' });
    const normalized = normalizeCategoryRule(undated);
    expect(normalizeCategoryRule(undated)).toEqual(normalized);
    expect(normalized.createdAt).toBe('');
    expect(applyCategoryRules({ type: 'expense', merchant: '全聯' }, [undated, dated], now).subcategory).toBe('便當');
  });

  it('matches a trimmed casefolded merchant or name exactly, never as a substring', () => {
    const rule = categoryRule({ match: ' Starbucks ' });
    expect(matchCategoryRule({ type: 'expense', merchant: ' ＳＴＡＲＢＵＣＫＳ ' }, rule)).toBe(true);
    expect(matchCategoryRule({ type: 'expense', name: 'Starbucks' }, rule)).toBe(true);
    expect(matchCategoryRule({ type: 'expense', merchant: 'Starbucks Reserve' }, rule)).toBe(false);
    expect(matchCategoryRule({ type: 'income', merchant: 'Starbucks' }, rule)).toBe(false);
  });

  it('uses the newest matching rule and protects manually edited transactions', () => {
    const original = { type: 'expense', merchant: '全聯', category: '其他', subcategory: '其他支出', aiStatus: 'pending' };
    const older = categoryRule({ id: 'rule-old', subcategory: '便當', createdAt: '2026-09-01T00:00:00.000Z' });
    const newer = categoryRule({ id: 'rule-new', createdAt: '2026-10-01T00:00:00.000Z' });
    const result = applyCategoryRules(original, [older, newer], now);
    expect(result).toMatchObject({
      category: '飲食',
      subcategory: '生鮮食材',
      userEditedAt: now,
      aiStatus: 'confirmed',
    });
    expect(original.category).toBe('其他');

    const edited = { ...original, userEditedAt: '2026-10-01T00:00:00.000Z' };
    expect(applyCategoryRules(edited, [newer, older], now)).toBe(edited);
  });
});

describe('local entry draft helpers', () => {
  function storage() {
    const data = new Map();
    return {
      data,
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key),
    };
  }

  it('persists bounded form fields only, including the transcript, then clears them', () => {
    const local = storage();
    const draft = saveEntryDraft({
      name: '午餐',
      amount: '120',
      transcript: 'x'.repeat(3000),
      manualOpen: 'true',
      apiToken: 'must not persist',
    }, local);

    expect(draft).toMatchObject({ name: '午餐', amount: '120', transcript: 'x'.repeat(2048), manualOpen: true });
    expect(draft).not.toHaveProperty('apiToken');
    expect(readEntryDraft(local)).toEqual(draft);
    expect(clearEntryDraft(local)).toBe(true);
    expect(readEntryDraft(local)).toBeNull();
  });

  it('returns safely when local storage is unavailable', () => {
    const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(readEntryDraft(unavailable)).toBeNull();
    expect(saveEntryDraft({ name: 'x' }, unavailable)).toBeNull();
    expect(clearEntryDraft(unavailable)).toBe(false);
  });
});
