import { describe, expect, it, vi } from 'vitest';
import { makeShortcut, plist } from '../ios-shortcuts/build.mjs';
import { createTransaction } from '../src/domain/transactions.js';
import { enqueueSpokenEntry, syncLedgerChangesToSheet } from '../src/services/import-proxy.js';

describe('LINE notification shortcut files', () => {
  it('provides the simple notification → full text → single GAS request flow without file access', () => {
    const simple = makeShortcut(false, true);
    const actions = simple.WFWorkflowActions;
    expect(simple.WFWorkflowName).toBe('小帳LINE簡單記帳');
    expect(simple.WFWorkflowTriggers).toEqual([{ WFTriggerIdentifier: 'WFNotificationTrigger',
      WFTriggerSerializedParameters: {}, WFTriggerUUID: expect.stringMatching(/^[0-9A-F-]{36}$/) }]);
    const requests = actions.filter(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl');
    expect(requests).toHaveLength(1);
    const parameters = requests[0].WFWorkflowActionParameters;
    expect(parameters.WFHTTPMethod).toBe('POST');
    expect(parameters.WFHTTPBodyType).toBe('JSON');
    const fields = parameters.WFJSONValues.Value.WFDictionaryFieldValueItems;
    expect(fields.map(field => field.WFKey.Value.string)).toEqual(['action', 'proxyToken', 'groupId', 'transcript']);
    expect(fields[0].WFValue.Value.string).toBe('enqueueSpokenEntry');
    const transcript = actions.find(a => a.WFWorkflowActionParameters.UUID === fields[3].WFValue.Value.attachmentsByRange['{0, 1}'].OutputUUID);
    expect(transcript.WFWorkflowActionParameters.WFTextActionText.Value.string).toContain('付款帳戶：LINE');
    const xml = plist(simple);
    expect(xml).not.toMatch(/documentpicker|file\.delete|file\.select|file\.createfolder|askllm|getLedgerCapabilities/);
    expect(xml).toContain('^https://script\\.google\\.com/macros/s/');
    expect(actions.length).toBeLessThan(makeShortcut().WFWorkflowActions.length / 2);
    const ids = new Set();
    const scan = item => {
      if (!item || typeof item !== 'object') return;
      if (item.OutputUUID) expect(ids.has(item.OutputUUID)).toBe(true);
      if (item.attachmentsByRange) for (const range of Object.keys(item.attachmentsByRange)) {
        expect(item.string[Number(range.match(/\d+/)[0])]).toBe('\uFFFC');
      }
      Object.values(item).forEach(scan);
    };
    for (const action of actions) {
      scan(action.WFWorkflowActionParameters);
      ids.add(action.WFWorkflowActionParameters.UUID);
    }
  });

  it.each([false, true])('wires native actions, private local configuration and safe acknowledgement (retry=%s)', retry => {
    const workflow = makeShortcut(retry);
    const actions = workflow.WFWorkflowActions;
    const ids = new Set();
    const scan = item => {
      if (!item || typeof item !== 'object') return;
      if (item.OutputUUID) expect(ids.has(item.OutputUUID)).toBe(true);
      if (item.attachmentsByRange) {
        for (const range of Object.keys(item.attachmentsByRange)) {
          const index = Number(range.match(/\d+/)[0]);
          expect(item.string[index]).toBe('\uFFFC');
        }
      }
      Object.values(item).forEach(scan);
    };
    for (const action of actions) {
      scan(action.WFWorkflowActionParameters);
      ids.add(action.WFWorkflowActionParameters.UUID);
      if (action.WFWorkflowActionIdentifier === 'is.workflow.actions.conditional'
        && action.WFWorkflowActionParameters.WFControlFlowMode === 0) {
        expect(action.WFWorkflowActionParameters.WFCondition).toBe(0); // Numeric "less than", not string equals.
        expect(action.WFWorkflowActionParameters.WFNumberValue).toBe('1');
        expect(action.WFWorkflowActionParameters.WFInput.Type).toBe('Variable');
        const ending = actions.find(a => a.WFWorkflowActionParameters.WFControlFlowMode === 2
          && a.WFWorkflowActionParameters.GroupingIdentifier === action.WFWorkflowActionParameters.GroupingIdentifier);
        expect(ending).toBeDefined();
      }
    }
    expect(ids.size).toBe(actions.length);
    const question = workflow.WFWorkflowImportQuestions[0];
    expect(actions[question.ActionIndex].WFWorkflowActionIdentifier).toBe('is.workflow.actions.gettext');
    const requests = actions.filter(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl');
    expect(requests).toHaveLength(2);
    expect(requests[0].WFWorkflowActionParameters.WFJSONValues.Value.WFDictionaryFieldValueItems[0].WFValue.Value.string).toBe('getLedgerCapabilities');
    expect(requests[1].WFWorkflowActionParameters.WFJSONValues.Value.WFDictionaryFieldValueItems.map(field => field.WFKey.Value.string))
      .toEqual(['action', 'proxyToken', 'groupId', 'transcript']);
    const xml = plist(workflow);
    expect(xml).not.toContain('askllm');
    expect(xml).toContain('^https://script\\.google\\.com/macros/s/');
    expect(xml).toContain('^multi:');
    expect(xml).toContain('lineNotificationVersion');
    if (!retry) {
      expect(actions.findIndex(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.documentpicker.save'))
        .toBeLessThan(actions.indexOf(requests[0]));
    }
    expect(actions.findIndex(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.file.delete'))
      .toBeGreaterThan(actions.indexOf(requests[1]));
  });

  it('preserves long notification metadata through app normalization and Sheet projection', async () => {
    const transcript = '付款完成 LINE 商家資訊'.repeat(40) + ' 實付120元';
    const transaction = createTransaction({ type: 'expense', name: '午餐', amount: 120,
      category: '飲食', subcategory: '便當', date: '2026-10-01', account: 'line',
      source: 'voice', rawTranscript: transcript }, { id: 'voice:line-test' });
    expect(transaction.rawTranscript).toBe(transcript);
    const fetchImpl = vi.fn(async (_url, options) => ({ ok: true,
      json: async () => ({ ok: true, data: JSON.parse(options.body).action === 'enqueueSpokenEntry'
        ? { queueId: 'queue-1', status: 'pending' } : { accountCount: 0, transactionCount: 1, budgetCount: 0 } }),
    }));
    await enqueueSpokenEntry({ endpoint: 'https://example.com', transcript }, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).transcript).toBe(transcript);
    await syncLedgerChangesToSheet({ endpoint: 'https://example.com', state: { transactions: [transaction] },
      changes: { upserts: [transaction.id] } }, { fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).changes.transactions[0].rawTranscript).toBe(transcript);
    const oversized = enqueueSpokenEntry({ endpoint: 'https://example.com', transcript: '字'.repeat(2049) }, { fetchImpl });
    await expect(oversized).rejects.toThrow('2048');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
