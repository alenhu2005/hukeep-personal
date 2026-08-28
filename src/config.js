import { EXPENSE_TAXONOMY, INCOME_TAXONOMY } from './domain/category-taxonomy.js';

export const EXPENSE_CATEGORIES = Object.keys(EXPENSE_TAXONOMY);

export const INCOME_CATEGORIES = Object.keys(INCOME_TAXONOMY);

export const TYPE_LABELS = {
  expense: '支出',
  income: '收入',
  transfer: '轉帳',
};

export const CATEGORY_TONES = {
  '飲食': 'coral',
  '交通': 'blue',
  '居家': 'olive',
  '購物': 'violet',
  '娛樂': 'amber',
  '醫療': 'mint',
  '學習': 'blue',
  '帳單': 'slate',
  '人情': 'coral',
  '寵物': 'amber',
  '其他': 'slate',
  '薪資': 'mint',
  '獎金': 'amber',
  '接案': 'blue',
  '投資': 'olive',
  '退款': 'violet',
  '禮金': 'coral',
  '其他收入': 'slate',
};
