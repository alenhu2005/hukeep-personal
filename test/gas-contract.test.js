import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../gas/invoice-proxy.gs', import.meta.url), 'utf8');

describe('GAS 同步合約', () => {
  it('保持可解析的 JavaScript 語法', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('功能設定同步逐項合併，並保留明確刪除而不清除其他裝置項目', () => {
    const merge = new Function(`${source}\nreturn mergeFeatureSettings_;`)();
    const rule = id => ({ id, name: id, type: 'expense', amount: 10, category: '生活', account: 'cash', cadence: 'monthly', day: 1, startDate: '2026-01-01' });
    const result = merge({
      recurringRules: [rule('remove'), rule('remote')],
      monthlySnapshots: [{ month: '2026-08', assetTotal: 1 }],
      reconciliations: [],
    }, {
      recurringRules: [rule('local')],
    }, { recurringRules: ['remove'] }, false, { recurringRules: true });

    expect(result.recurringRules).toEqual([
      expect.objectContaining({ id: 'remote' }),
      expect.objectContaining({ id: 'local' }),
    ]);
    expect(result.monthlySnapshots).toEqual([{ month: '2026-08', assetTotal: 1 }]);
    expect(source).toContain('featureSettingsVersion: 1');
    expect(source).toContain('changes.featureSettingsDelta');
  });

  it('固定流水保留明確的手續費模式', () => {
    const merge = new Function(`${source}\nreturn mergeFeatureSettings_;`)();
    const rule = {
      id: 'recurring-transfer', name: '轉帳', type: 'transfer', amount: 10000, fee: 12,
      feeMode: 'included', account: 'sinopac', toAccount: 'post', cadence: 'monthly',
      day: 1, startDate: '2026-01-01',
    };
    expect(merge({}, { recurringRules: [rule] }, {}, true).recurringRules[0]).toMatchObject({
      feeMode: 'included', fee: 12,
    });
  });

  it('保留帳本 Sheet 同步，但不再暴露載具 API、排程或財政部 AppID 設定', () => {
    expect(source).toContain("body.action === 'syncLedgerState'");
    expect(source).toContain("body.action === 'syncLedgerChanges'");
    expect(source).toContain("body.action === 'getLedgerCapabilities'");
    expect(source).toContain('transferFeeModeVersion: 1');
    expect(source).toContain("body.action === 'loadLedgerState'");
    expect(source).toContain("requiredProperty_('SPREADSHEET_ID')");
    expect(source).toContain('小帳_帳戶');
    expect(source).toContain('小帳_交易');
    expect(source).not.toContain("body.action === 'syncCarrierInvoices'");
    expect(source).not.toContain('EINVOICE_APP_ID');
    expect(source).not.toContain('EINVOICE_UUID');
    expect(source).not.toContain('callEinvoice_');
    expect(source).not.toContain('1nlUSUpk5F4fnhDRTPWS4KlIIfqAYWkT6xn3965Xl8N-eRKiFyVjqNO4w');
  });

  it('提供不寫入 Sheet 的已授權模式能力檢查', () => {
    const capabilities = new Function(`${source}\nreturn getLedgerCapabilities_;`)();
    expect(capabilities()).toEqual({ transferFeeModeVersion: 1 });
  });

  it('不再提供發票或銀行連線操作與轉送端點', () => {
    expect(source).not.toContain('relayEInvoicePreview');
    expect(source).not.toContain('EINVOICE_RELAY');
    expect(source).not.toContain('authorizeEInvoicePreview');
    expect(source).not.toContain('workers.dev');
  });

  it('提供受授權的精準 Sheet 刪除操作，而非只從本機移除', () => {
    expect(source).toContain("body.action === 'deleteLedgerTransaction'");
    expect(source).toContain("body.action === 'deleteLedgerBudget'");
    expect(source).toContain('function deleteLedgerTransaction_(');
    expect(source).toContain('function deleteLedgerBudget_(');
    expect(source).toContain('.deleteRow(');
  });

  it('預設使用最新穩定的 Gemini 3.7 Flash，並允許以指令碼屬性覆寫', () => {
    expect(source).toContain("var DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash'");
    expect(source).toContain("optionalProperty_('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL");
    expect(source).not.toContain("var GEMINI_MODEL = 'gemini-2.5-flash'");
    expect(source).not.toContain('temperature:');
  });

  it('Gemini 結構化輸出的帳戶 enum 不包含無效空字串', () => {
    expect(source).not.toContain("enum: [''].concat(ACCOUNT_IDS)");
    expect(source).toContain("toAccount: { type: 'STRING', enum: ACCOUNT_IDS }");
    expect(source).toContain("'post', 'investment'");
  });

  it('投資資產轉帳保留投資大小分類，普通轉帳仍無分類', () => {
    const normalize = new Function(`${source}\nreturn normalizeSpokenClassification_;`)();

    expect(normalize('transfer', '投資', 'ETF', 'sinopac', 'investment')).toEqual({
      category: '投資', subcategory: 'ETF',
    });
    expect(normalize('transfer', '', '', 'cash', 'line')).toEqual({ category: '', subcategory: '' });
    expect(source).toContain('投資本金不是支出');
    expect(source).toContain('沒指定時回 sinopac');
  });

  it('GAS 以完整交易固定校準投資快照，阻止舊裝置覆寫錯誤金額', () => {
    const canonicalOpening = new Function(`${source}\nreturn canonicalInvestmentOpeningBalance_;`)();
    const effect = new Function(`${source}\nreturn investmentBalanceEffect_;`)();
    const oldTransactions = [
      { type: 'transfer', amount: 11538, fee: 0, account: 'sinopac', toAccount: 'investment', date: '2026-09-01' },
    ];
    const withNewBuy = [
      ...oldTransactions,
      { type: 'transfer', amount: 1000, fee: 0, account: 'sinopac', toAccount: 'investment', date: '2026-09-19' },
    ];

    expect(canonicalOpening(oldTransactions)).toBe(1353);
    expect(canonicalOpening(withNewBuy)).toBe(1353);
    expect(effect({ type: 'transfer', amount: 10000, fee: 12, feeMode: 'included', account: 'sinopac', toAccount: 'investment' })).toBe(9988);
    expect(effect({ type: 'transfer', amount: 10000, fee: 12, feeMode: 'additional', account: 'investment', toAccount: 'sinopac' })).toBe(-10012);
    expect(source).toContain('repairInvestmentAccountSheet_(accountSheet, transactionSheet)');
  });

  it('轉帳列在原有欄位後附加模式，舊空白模式讀回外加', () => {
    const { row, fromRow, headers } = new Function('Utilities', `${source}\nreturn {
      row: ledgerTransactionRow_, fromRow: ledgerTransactionFromRow_, headers: LEDGER_TRANSACTION_HEADERS,
    };`)({ formatDate: () => '2026-09-01' });
    const transaction = {
      id: 'transfer-mode', type: 'transfer', name: '轉帳', amount: 10000, fee: 12,
      feeMode: 'included', account: 'sinopac', toAccount: 'post', date: '2026-09-01',
    };
    const values = row(transaction);

    expect(headers.at(-1)).toBe('手續費方式');
    expect(values).toHaveLength(28);
    expect(values[22]).toBe(12);
    expect(values[27]).toBe('included');
    expect(fromRow(values)).toMatchObject({ fee: 12, feeMode: 'included' });
    expect(fromRow(values.slice(0, 27))).toMatchObject({ fee: 12, feeMode: 'additional' });
    expect(() => row({ ...transaction, feeMode: 'included', fee: 10000 })).toThrow('必須小於金額');
  });

  it('口語審查保留草稿的明確模式，並可接收 AI 辨識的內扣模式', () => {
    const review = new Function(`${source}\nreturn validateSpokenReview_;`)();
    const fallback = {
      id: 'voice-transfer', type: 'transfer', amount: 10000, fee: 12, feeMode: 'included',
      account: 'sinopac', toAccount: 'post', date: '2026-09-01', name: '轉帳',
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const ai = {
      type: 'transfer', amount: 10000, fee: 12, feeMode: 'additional', date: '2026-09-01',
      account: 'cash', toAccount: 'line', name: '轉帳', note: '', category: '', subcategory: '',
    };
    const trusted = review(ai, fallback, '含手續費轉帳一萬元，手續費十二元');
    expect(trusted).toMatchObject({ feeMode: 'included' });
    expect(trusted.aiChanges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: '手續費方式' }),
    ]));

    const inferred = review({ ...ai, feeMode: 'included' }, { ...fallback, feeMode: undefined }, '內扣轉帳');
    expect(inferred.feeMode).toBe('included');
    expect(source).toContain('含手續費');
    expect(source).toContain('額外收');
  });

  it('轉帳手續費會儲存到 Sheet，並納入口語 AI 審查 schema', () => {
    expect(source).toContain("'手續費'");
    expect(source).toContain("fee: { type: 'NUMBER'");
    expect(source).toContain('轉帳手續費只會用在轉帳');
  });

  it('提供只用來完成試算表 OAuth 的公開授權函式', () => {
    expect(source).toContain('function authorizeSpreadsheetAccess()');
    expect(source).toContain("SpreadsheetApp.openById(requiredProperty_('SPREADSHEET_ID'))");
  });

  it('手機綁定碼只能由已授權裝置產生，兑換後立即作廢', () => {
    const claimIndex = source.indexOf("body.action === 'claimDeviceBinding'");
    const authorizeIndex = source.indexOf('authorize_(body.proxyToken)');
    const createIndex = source.indexOf("body.action === 'createDevicePairingCode'");

    expect(claimIndex).toBeGreaterThan(0);
    expect(claimIndex).toBeLessThan(authorizeIndex);
    expect(createIndex).toBeGreaterThan(authorizeIndex);
    expect(source).toContain("setProperty('DEVICE_PAIRING_CODE_HASH'");
    expect(source).toContain("deleteProperty('DEVICE_PAIRING_CODE_HASH')");
    expect(source).toContain('enforcePairingClaimRateLimit_');
    expect(source).not.toContain("setProperty('DEVICE_PAIRING_CODE',");
  });

  it('口語條目先入 Sheet 佇列，再由背景 AI 更新且尊重手動鎖定', () => {
    expect(source).toContain("body.action === 'enqueueSpokenEntry'");
    expect(source).toContain('小帳_語音佇列');
    expect(source).toContain("newTrigger('processPendingSpokenEntries')");
    expect(source).toContain('function processPendingSpokenEntries()');
    expect(source).toContain('userEditedAt');
    expect(source).toContain('使用者鎖定');
  });

  it('多品項口語會建立獨立佇列，AI 不得合併或改掉已辨識的付款資訊', () => {
    expect(source).toContain('function spokenDraftsFromBody_(');
    expect(source).toContain("'multi:' + queueGroupId + ':' + (index + 1)");
    expect(source).toContain('requestedGroupId');
    expect(source).toContain('transaction.groupId = groupId');
    expect(source).toContain('一次最多辨識 10 個品項');
    expect(source).toContain('必須保留該草稿的品名、金額、日期與付款帳戶');
    expect(source).toContain("indexOf('multi:') === 0");
  });

  it('口語備註會精簡原文，完整原文只保留在 rawTranscript', () => {
    const conciseNote = new Function(`${source}\nreturn conciseSpokenNote_;`)();

    expect(
      conciseNote('昨天跟小明在鼎王吃麻辣鍋一千二用永豐', '跟小明在鼎王吃麻辣鍋', 'expense'),
    ).toBe('與小明');
    expect(conciseNote('家教賺了 1200 匯到我的 LINE 裡面', '家教', 'income')).toBe('');
    expect(source).toContain('conciseSpokenNote_(transcript');
    expect(source).toContain("if (note === transcript) note = ''");
    expect(source).toContain('function trustedReviewedNote_(');
    expect(source).toContain('不得寫成口語句子');
    expect(source).toContain('rawTranscript: transcript');
    expect(source).toContain('不可逐字照抄口語原文');
  });

  it('寫入口語佇列不會因觸發器尚未授權而報錯', () => {
    const enqueueBody = source.match(/function enqueueSpokenEntry_\([\s\S]*?\n}\n\nfunction normalizeSpokenDraft_/)?.[0] || '';
    const installerBody = source.match(/function installBackgroundProcessing\(\)[\s\S]*?\n}/)?.[0] || '';

    expect(enqueueBody).toContain('try {\n    ensureSpokenQueueTrigger_();');
    expect(enqueueBody).toContain('口語佇列已寫入，但背景觸發器尚未授權');
    expect(installerBody).not.toContain('catch (triggerError)');
  });

  it('自動修復舊版「日期在第一欄」的交易列', () => {
    const normalizeRow = new Function(`${source}\nreturn normalizeLedgerTransactionRow_;`)();
    const legacyRow = [
      '2026-08-27', 'voice:test', 'income', '家教', 2500, '接案', '家教', 'bot', '', '口語原文',
      'voice', 'test', '', '', '[]', 'created', 'updated', '', '', 'pending', '', '口語原文',
    ];

    expect(normalizeRow(legacyRow)).toEqual([
      'voice:test', 'income', '家教', 2500, '接案', '家教', 'bot', '', '2026-08-27', '口語原文',
      'voice', 'test', '', '', '[]', 'created', 'updated', '', '', 'pending', '', '口語原文', '', '', '', '', '',
      '',
    ]);
  });

  it('從 Sheet 讀回日期儀存格時仍回傳 yyyy-MM-dd', () => {
    const fromRow = new Function('Utilities', `${source}\nreturn ledgerTransactionFromRow_;`)({
      formatDate: () => '2026-08-27',
    });
    const row = [
      'voice:test', 'income', '家教', 2500, '接案', '家教', 'bot', '', new Date('2026-08-27T00:00:00+08:00'),
      '備註', 'voice', 'test', '', '', '[]', 'created', 'updated', '', '', 'pending', '', '口語原文',
    ];

    expect(fromRow(row).date).toBe('2026-08-27');
  });

  it('AI 暫時錯誤會自動重試，但最多三次', () => {
    const retryable = new Function(`${source}\nreturn retryableSpokenFailure_;`)();

    expect(retryable('失敗', 'AI 審核暫時無法使用', 1)).toBe(true);
    expect(retryable('失敗', 'AI 審核暫時無法使用', 3)).toBe(false);
    expect(retryable('失敗', 'AI 無法辨識正確金額', 1)).toBe(false);
  });
});
