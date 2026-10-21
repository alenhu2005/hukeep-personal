import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { enqueueSpokenEntry, syncLedgerChangesToSheet } from '../src/services/import-proxy.js';

it('GAS 接受 Bito 投資分類與每日規則，保留帳戶與原交易', () => {
  const source = readFileSync(new URL('../gas/invoice-proxy.gs', import.meta.url), 'utf8');
  const api = new Function(`${source}\nreturn { ids: ACCOUNT_IDS, classify: normalizeSpokenClassification_, features: normalizeFeatureSettings_, review: validateSpokenReview_ };`)();
  expect(api.ids).toContain('bito');
  expect(api.classify('transfer', '其他', '', 'sinopac', 'bito')).toEqual({ category: '投資', subcategory: '加密資產' });
  const settings = { recurringRules: [{ id: 'daily', cadence: 'daily', account: 'sinopac', toAccount: 'bito' }] };
  expect(api.features(settings).recurringRules).toEqual(settings.recurringRules);
});

it('舊 GAS 不可接收 Bito 語音資料，佇列上傳與直接送出都先擋下以免錯帳', async () => {
  const calls = [];
  let updated = false;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const data = request.action === 'getLedgerCapabilities'
      ? { enhancementsVersion: 1, ...(updated ? { bitoAccountVersion: 1 } : {}) }
      : { queueId: 'bito-queue', status: 'pending', transactions: [tx] };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  };
  const tx = { id: 'bito-voice', type: 'transfer', amount: 1000, account: 'sinopac', toAccount: 'bito',
    date: '2026-10-21', category: '投資', source: 'voice', aiStatus: 'pending' };
  await expect(enqueueSpokenEntry({ endpoint: 'https://bito-old.example/proxy', transcript: 'Bito買比特幣1000', draft: tx }, { fetchImpl }))
    .rejects.toThrow('已保留本機');
  await expect(syncLedgerChangesToSheet({ endpoint: 'https://bito-old.example/proxy', state: { transactions: [tx] },
    changes: { upserts: [tx.id] } }, { fetchImpl })).rejects.toThrow('已保留本機');
  expect(calls.every(call => call.action === 'getLedgerCapabilities')).toBe(true);
  updated = true;
  const result = await enqueueSpokenEntry({ endpoint: 'https://bito-old.example/proxy', transcript: 'Bito買比特幣1000', draft: tx }, { fetchImpl });
  expect(result.transactions[0]).toMatchObject({ account: 'sinopac', toAccount: 'bito' });
});
