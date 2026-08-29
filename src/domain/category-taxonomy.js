export const EXPENSE_TAXONOMY = Object.freeze({
  '飲食': Object.freeze([
    '早餐',
    '便當',
    '台式料理',
    '日式料理',
    '韓式料理',
    '東南亞料理',
    '火鍋',
    '燒烤',
    '炸物',
    '速食',
    '麵食',
    '飲料',
    '咖啡',
    '甜品',
    '零食',
    '生鮮食材',
    '酒類',
    '聚餐',
    '其他飲食',
  ]),
  '交通': Object.freeze([
    '大眾運輸',
    '計程車',
    '高鐵火車',
    '機票',
    '加油',
    '停車',
    '維修保養',
    '租車',
    '通行費',
    '其他交通',
  ]),
  '居家': Object.freeze([
    '房租',
    '房貸',
    '水電',
    '瓦斯',
    '網路通訊',
    '家具',
    '家電',
    '清潔用品',
    '修繕',
    '管理費',
    '其他居家',
  ]),
  '購物': Object.freeze([
    '服飾',
    '鞋包',
    '3C',
    '美妝',
    '日用品',
    '網購',
    '書籍文具',
    '禮物',
    '其他購物',
  ]),
  '娛樂': Object.freeze([
    '電影',
    '音樂',
    '遊戲',
    '展覽',
    '運動',
    '旅行',
    'KTV',
    '訂閱',
    '興趣',
    '其他娛樂',
  ]),
  '醫療': Object.freeze([
    '門診',
    '藥品',
    '牙科',
    '眼科',
    '健檢',
    '保健品',
    '醫療保險',
    '其他醫療',
  ]),
  '學習': Object.freeze(['課程', '補習', '書籍', '軟體工具', '證照', '講座', '其他學習']),
  '帳單': Object.freeze(['稅金', '保險', '手續費', '罰單', '會員費', '其他帳單']),
  '投資': Object.freeze([
    '股票',
    'ETF',
    '基金',
    '債券',
    '加密資產',
    '定期定額',
    '交易手續費',
    '投資工具',
    '投資課程',
    '其他投資',
  ]),
  '人情': Object.freeze(['紅包', '禮金', '捐款', '孝親', '請客', '其他人情']),
  '寵物': Object.freeze(['飼料', '醫療', '美容', '用品', '其他寵物']),
  '其他': Object.freeze(['其他支出']),
});

export const INCOME_TAXONOMY = Object.freeze({
  '薪資': Object.freeze(['固定薪資', '兼職薪資', '加班費', '津貼', '未休假獎金']),
  '獎金': Object.freeze(['年終獎金', '績效獎金', '公司分紅', '推薦獎金', '其他獎金']),
  '接案': Object.freeze(['專案收入', '家教', '稿費', '顧問費', '講師費', '佣金']),
  '投資': Object.freeze([
    '股息',
    '股票股息',
    'ETF配息',
    '資本利得',
    '利息',
    '存款利息',
    '基金收益',
    '債券收益',
    '債券利息',
    '加密資產',
    '加密資產收益',
    '其他投資收益',
  ]),
  '租賃': Object.freeze(['房租收入', '車位租金', '設備租金', '其他租賃']),
  '退款與理賠': Object.freeze(['消費退款', '退稅', '保險理賠', '報帳核銷', '押金退回']),
  '補助': Object.freeze(['政府補助', '育兒津貼', '獎學金', '失業給付', '其他補助']),
  '零用與贈與': Object.freeze(['零用錢', '生活費', '親友贈與', '家用補貼']),
  '禮金': Object.freeze(['紅包', '禮金', '其他贈與']),
  '銷售': Object.freeze(['二手出售', '商品銷售', '其他銷售']),
  '中獎': Object.freeze(['發票中獎', '彩券中獎', '抽獎', '其他中獎']),
  '其他收入': Object.freeze(['其他收入']),
});

const DEFAULT_FALLBACK = Object.freeze({
  topCategory: '其他',
  subcategory: '其他支出',
  confidence: 0,
});

const LOCAL_RULES = [
  ['飲食', '火鍋', ['火鍋', '麻辣鍋', '涮涮鍋', '鍋物', '鼎王', '海底撈']],
  ['飲食', '燒烤', ['燒肉', '燒烤', '烤肉', '串燒']],
  ['飲食', '炸物', ['鹹酥雞', '炸雞', '炸物', '雞排', '薯條']],
  ['飲食', '甜品', ['蛋糕', '甜點', '甜品', '冰淇淋', '豆花', '布丁', '鬆餅']],
  ['飲食', '咖啡', ['咖啡', '拿鐵', '星巴克', '路易莎', 'cafe', 'coffee']],
  ['飲食', '飲料', ['手搖', '珍珠奶茶', '飲料', '茶飲']],
  ['飲食', '速食', ['麥當勞', '肯德基', '漢堡王', '摩斯', '漢堡']],
  ['飲食', '生鮮食材', ['家樂福', '全聯', '好市多', '超市', '生鮮', '蔬菜', '水果']],
  ['交通', '高鐵火車', ['高鐵', '台鐵', '火車', '鐵路', '車票']],
  ['交通', '計程車', ['計程車', 'uber', 'taxi', '多元計程車']],
  ['交通', '大眾運輸', ['捷運', '公車', '悠遊卡', '一卡通']],
  ['交通', '加油', ['加油', '中油', '台塑石油', '汽油', '柴油']],
  ['投資', '交易手續費', ['證交稅', '交易稅', '下單手續費', '證券手續費']],
  ['投資', 'ETF', ['etf', '0050', '0056', '00878', '00919']],
  ['投資', '股票', ['買股', '股票', '個股', '證券下單']],
  ['投資', '基金', ['買基金', '基金申購']],
  ['投資', '債券', ['買債券', '公債', '公司債']],
  ['投資', '加密資產', ['比特幣', '以太幣', '加密貨幣', 'bitcoin', 'crypto']],
  ['投資', '定期定額', ['定期定額']],
  ['投資', '投資課程', ['投資課程', '理財課程']],
  ['投資', '投資工具', ['看盤軟體', '選股工具', '投資工具']],
  ['居家', '網路通訊', ['中華電信', '台灣大哥大', '遠傳', '網路費', '光世代', '電話費']],
  ['居家', '水電', ['水費', '電費', '台電', '自來水']],
  ['居家', '房租', ['房租', '租金']],
  ['醫療', '藥品', ['藥局', '藥品', '感冒藥', '退燒藥', '處方藥']],
  ['醫療', '門診', ['診所', '醫院', '掛號費', '門診']],
  ['購物', '3C', ['燦坤', '順發', 'apple', '手機', '電腦', '耳機', '3c']],
  ['娛樂', '電影', ['電影院', '電影票', '威秀', '秀泰', '國賓影城']],
  ['娛樂', '訂閱', ['netflix', 'spotify', 'youtube premium', '訂閱']],
  ['學習', '課程', ['課程', '學費', '線上課', '補習班']],
  ['寵物', '飼料', ['寵物飼料', '貓糧', '狗糧', '罐罐']],
];

export function getSubcategories(topCategory, type = 'expense') {
  const taxonomy = type === 'income' ? INCOME_TAXONOMY : EXPENSE_TAXONOMY;
  return [...(taxonomy[topCategory] ?? [])];
}

export function validateClassification(output, options = {}) {
  const taxonomy = options.type === 'income' ? INCOME_TAXONOMY : EXPENSE_TAXONOMY;
  const fallback = options.fallback ? { ...options.fallback } : { ...DEFAULT_FALLBACK };
  const topCategory = String(output?.topCategory ?? '').trim();
  const subcategory = String(output?.subcategory ?? '').trim();
  const confidence = Number(output?.confidence);

  if (!taxonomy[topCategory]?.includes(subcategory)) return fallback;
  return {
    topCategory,
    subcategory,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  };
}

export function classifyLocally(input = {}) {
  const merchant = String(input.merchant ?? '');
  const items = Array.isArray(input.items) ? input.items.join(' ') : String(input.items ?? '');
  const searchable = `${merchant} ${items}`.normalize('NFKC').toLocaleLowerCase('zh-Hant');
  const rule = LOCAL_RULES.find(([, , keywords]) =>
    keywords.some(keyword => searchable.includes(keyword.toLocaleLowerCase('zh-Hant'))),
  );

  if (!rule) return { ...DEFAULT_FALLBACK };
  return { topCategory: rule[0], subcategory: rule[1], confidence: 0.9 };
}

const INCOME_LOCAL_RULES = [
  ['中獎', '發票中獎', ['發票中獎', '雲端發票中獎', '統一發票中獎']],
  ['中獎', '彩券中獎', ['彩券', '威力彩', '大樂透', '今彩']],
  ['中獎', '抽獎', ['抽獎', '抽中']],
  ['零用與贈與', '零用錢', ['零用錢', '零花錢']],
  ['零用與贈與', '生活費', ['生活費']],
  ['零用與贈與', '家用補貼', ['家用', '家用補貼']],
  ['接案', '家教', ['家教', '補習授課']],
  ['接案', '稿費', ['稿費', '寫稿']],
  ['接案', '顧問費', ['顧問費', '顧問收入']],
  ['接案', '講師費', ['講師費', '講課費']],
  ['接案', '佣金', ['佣金', '介紹費']],
  ['接案', '專案收入', ['接案', '專案收入']],
  ['薪資', '兼職薪資', ['兼職', '打工薪水']],
  ['薪資', '加班費', ['加班費']],
  ['薪資', '津貼', ['薪資津貼', '交通津貼', '飯錢津貼']],
  ['薪資', '固定薪資', ['薪水', '薪資', '工資']],
  ['獎金', '年終獎金', ['年終', '年終獎金']],
  ['獎金', '績效獎金', ['績效獎金', '績效']],
  ['獎金', '公司分紅', ['公司分紅', '員工分紅']],
  ['獎金', '其他獎金', ['獎金']],
  ['投資', 'ETF配息', ['etf配息', 'etf 配息', 'etf股息', 'etf 股息']],
  ['投資', '股票股息', ['股票股息', '現金股利', '股票配息']],
  ['投資', '股息', ['股息', '股利']],
  ['投資', '債券利息', ['債息', '債券利息']],
  ['投資', '加密資產收益', ['加密資產收益', '加密貨幣獲利', 'staking']],
  ['投資', '存款利息', ['存款利息', '活存利息', '定存利息']],
  ['投資', '利息', ['利息']],
  ['投資', '基金收益', ['基金贖回', '基金收益']],
  ['租賃', '房租收入', ['房租收入', '收房租']],
  ['退款與理賠', '退稅', ['退稅']],
  ['退款與理賠', '保險理賠', ['保險理賠', '理賠金']],
  ['退款與理賠', '報帳核銷', ['報帳', '核銷']],
  ['退款與理賠', '消費退款', ['退款', '退費']],
  ['補助', '獎學金', ['獎學金']],
  ['補助', '育兒津貼', ['育兒津貼', '育兒補助']],
  ['補助', '政府補助', ['政府補助', '普發現金']],
  ['禮金', '紅包', ['紅包']],
  ['禮金', '禮金', ['禮金']],
  ['銷售', '二手出售', ['二手', '賣掉舊物']],
];

export function classifyIncomeLocally(value = '') {
  const searchable = String(value).normalize('NFKC').toLocaleLowerCase('zh-Hant');
  const rule = INCOME_LOCAL_RULES.find(([, , keywords]) =>
    keywords.some(keyword => searchable.includes(keyword.toLocaleLowerCase('zh-Hant'))),
  );
  if (!rule) {
    return { topCategory: '其他收入', subcategory: '其他收入', confidence: 0 };
  }
  return { topCategory: rule[0], subcategory: rule[1], confidence: 0.9 };
}
