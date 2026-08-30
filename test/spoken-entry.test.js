import { describe, expect, it } from 'vitest';
import { conciseSpokenNote, parseSpokenTransaction } from '../src/domain/spoken-entry.js';

const today = '2026-08-29';

describe('口語記帳解析', () => {
  it('從自然口語取得今日支出、金額、信用卡與詳細分類', () => {
    expect(
      parseSpokenTransaction('今天午餐吃鼎王麻辣鍋 680 元，刷卡', { today }),
    ).toMatchObject({
      type: 'expense',
      amount: 680,
      date: '2026-08-29',
      account: 'sinopac',
      category: '飲食',
      subcategory: '火鍋',
    });
  });

  it('理解昨天與高鐵分類', () => {
    expect(
      parseSpokenTransaction('昨天搭高鐵 1490 塊用信用卡', { today }),
    ).toMatchObject({
      type: 'expense',
      amount: 1490,
      date: '2026-08-28',
      account: 'sinopac',
      category: '交通',
      subcategory: '高鐵火車',
    });
  });

  it('理解收入與入帳帳戶', () => {
    expect(parseSpokenTransaction('今天薪水 50000 元入台銀', { today })).toMatchObject({
      type: 'income',
      amount: 50000,
      date: '2026-08-29',
      account: 'bot',
      category: '薪資',
      subcategory: '固定薪資',
    });
  });

  it.each([
    ['LINE 收到零用錢 3000 元', 'line'],
    ['永豐刷卡吃火鍋 680 元', 'sinopac'],
    ['郵局收到家教費 1200 元', 'post'],
    ['現金買咖啡 65 元', 'cash'],
  ])('理解客製帳戶 %#', (text, account) => {
    expect(parseSpokenTransaction(text, { today }).account).toBe(account);
  });

  it.each([
    ['收到零用錢 3000 元存銀行', '零用與贈與', '零用錢'],
    ['今天家教費 1200 元現金', '接案', '家教'],
    ['發票中獎 1000 元入帳', '中獎', '發票中獎'],
  ])('理解常見收入方案 %#', (text, category, subcategory) => {
    expect(parseSpokenTransaction(text, { today })).toMatchObject({
      type: 'income',
      category,
      subcategory,
    });
  });

  it('理解常見中文金額', () => {
    expect(parseSpokenTransaction('剛剛買咖啡六十五元付現', { today })).toMatchObject({
      amount: 65,
      account: 'cash',
      category: '飲食',
      subcategory: '咖啡',
    });
    expect(parseSpokenTransaction('收到獎金五萬元進銀行', { today }).amount).toBe(50000);
  });

  it.each([
    ['午餐 1,280 刷永豐', 1280],
    ['早餐六十五付現', 65],
    ['買衣服一千二用 LINE', 1200],
    ['收到薪水兩萬五入台銀', 25000],
    ['繳學費 3千5', 3500],
    ['今天買 0050 ETF 3000 用永豐', 3000],
  ])('沒有說元也能擷取日常金額 %#', (text, amount) => {
    expect(parseSpokenTransaction(text, { today }).amount).toBe(amount);
  });

  it('不把日期或 ETF 股票代碼當成金額', () => {
    expect(parseSpokenTransaction('8月15日要研究 0050 ETF', { today }).amount).toBeNull();
  });

  it('同時擷取主要名稱、精簡備註與中文日期', () => {
    const result = parseSpokenTransaction('八月十五號在鼎王吃麻辣鍋一千二用永豐', { today });
    expect(result).toMatchObject({
      amount: 1200,
      date: '2026-08-15',
      name: '鼎王吃麻辣鍋',
      note: '',
      account: 'sinopac',
      category: '飲食',
      subcategory: '火鍋',
    });
    expect(result.note).not.toBe(result.transcript);
  });

  it('把口語中有用但不屬於主要名稱的情境整理成短備註', () => {
    expect(
      conciseSpokenNote(
        '昨天跟小明在鼎王吃麻辣鍋一千二用永豐',
        '跟小明在鼎王吃麻辣鍋',
      ),
    ).toBe('與小明');
  });

  it('沒有主要名稱時仍移除日期、金額與付款資訊，只保留摘要', () => {
    expect(conciseSpokenNote('昨天搭高鐵 1490 元刷卡')).toBe('搭高鐵');
  });

  it.each([
    ['$680 吃火鍋刷卡', 680],
    ['＄1，２８０ 午餐付現', 1280],
    ['NT$ 3,500 繳學費', 3500],
    ['$ 六十五 買咖啡', 65],
  ])('容忍 iOS 語音輸入自動加入的貨幣符號 %#', (text, amount) => {
    const result = parseSpokenTransaction(text, { today });
    expect(result.amount).toBe(amount);
    expect(result.classificationText).not.toMatch(/(?:NT)?\$/i);
  });

  it('理解明確月日與帳戶轉帳', () => {
    expect(parseSpokenTransaction('8月15日從永豐轉 3000 元到郵局', { today })).toMatchObject({
      type: 'transfer',
      amount: 3000,
      date: '2026-08-15',
      account: 'sinopac',
      toAccount: 'post',
      category: null,
      subcategory: null,
    });
  });

  it('口語轉帳會辨識手續費，讓 AI 後台能交叉審查', () => {
    expect(parseSpokenTransaction('8月15日從永豐轉 3000 元到郵局，手續費 15 元', { today })).toMatchObject({
      type: 'transfer',
      amount: 3000,
      fee: 15,
      account: 'sinopac',
      toAccount: 'post',
    });
  });

  it('可分類投資支出與投資收入', () => {
    expect(parseSpokenTransaction('今天買 0050 ETF 3000 元用永豐', { today })).toMatchObject({
      type: 'expense',
      category: '投資',
      subcategory: 'ETF',
    });
    expect(parseSpokenTransaction('收到 0050 ETF 配息 1200 元入台銀', { today })).toMatchObject({
      type: 'income',
      category: '投資',
      subcategory: 'ETF配息',
    });
  });

  it('資訊不足仍回傳可編輯草稿，不自行捏造金額', () => {
    const result = parseSpokenTransaction('今天去一間新開的店', { today });

    expect(result.amount).toBeNull();
    expect(result.note).toBe('');
    expect(result.confidence).toBeLessThan(0.5);
  });
});
