import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// Native Shortcuts plist. AI review remains in the existing GAS queue.
const attachment = value => ({ Value: value, WFSerializationType: 'WFTextTokenAttachment' });
const input = attachment({ Type: 'ExtensionInput' });
function text(...parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') string += part;
    else {
      attachmentsByRange[`{${string.length}, 1}`] = part.Value;
      string += '\uFFFC';
    }
  }
  return { Value: { string, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' };
}
const dictionary = entries => ({
  Value: { WFDictionaryFieldValueItems: Object.entries(entries).map(([key, value]) => ({
    WFItemType: 0, WFKey: text(key), WFValue: text(value),
  })) },
  WFSerializationType: 'WFDictionaryFieldValue',
});

export function makeShortcut(retry = false, simple = false) {
  const actions = [];
  const add = (identifier, parameters = {}, outputName = 'Result') => {
    const UUID = randomUUID().toUpperCase();
    actions.push({ WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
      WFWorkflowActionParameters: { ...parameters, UUID } });
    return attachment({ Type: 'ActionOutput', OutputUUID: UUID, OutputName: outputName });
  };
  const value = (source, key) => add('getvalueforkey', {
    WFInput: source, WFDictionaryKey: key, WFGetDictionaryValueType: 'Value',
  }, 'Dictionary Value');
  const requireMatch = (source, pattern, message) => {
    const matches = add('text.match', { text: text(source), WFMatchTextPattern: pattern });
    const count = add('count', { WFInput: matches, Input: matches, WFCountType: 'Items' }, 'Count');
    const group = randomUUID().toUpperCase();
    add('conditional', { WFInput: { Type: 'Variable', Variable: count }, WFCondition: 0,
      WFNumberValue: '1', WFControlFlowMode: 0, GroupingIdentifier: group });
    add('notification', { WFNotificationActionTitle: '小帳', WFNotificationActionBody: message,
      WFNotificationActionSound: false });
    add('exit');
    add('conditional', { WFControlFlowMode: 2, GroupingIdentifier: group });
  };
  add('comment', { WFCommentActionText: simple
    ? '只需貼入小帳綁定連結，並設定通知來源為 LINE，標題包含 LINE錢包、訊息包含 付款完成。通知全文直接送給 GAS 審查；本版不存檔、不重送。請停用舊的同類通知自動化，避免兩套同時記帳。設定後勿分享此捷徑。'
    : retry
    ? '選取小帳LINE待送出資料夾內的 JSON；沿用原識別碼，送出成功後只刪除此待送檔。不要把同一通知重新交給新記帳捷徑。'
    : '將 LINE 錢包付款完成通知的內文作為捷徑輸入。先存待送檔，再送 GAS 審核，不在此擷取金額。綁定連結是私人通行資料，設定後勿分享此捷徑。' });
  const bindingIndex = actions.length;
  const binding = add('gettext', { WFTextActionText: '貼上小帳的綁定連結' }, 'Binding Link');
  let pendingFile, transcript, groupId;
  if (retry) {
    pendingFile = add('file.select', { SelectMultiple: false }, 'File');
    const pending = add('detect.dictionary', { WFInput: pendingFile }, 'Dictionary');
    transcript = value(pending, 'transcript');
    groupId = value(pending, 'groupId');
  } else {
    const notification = add('gettext', { WFTextActionText: text(input) }, 'Notification Text');
    requireMatch(notification, '付款完成', '沒有付款完成通知內容，沒有記帳。');
    const currentDate = add('date', { WFDateActionMode: 'Current Date' }, 'Date');
    const receivedAt = add('format.date', { WFDate: text(currentDate),
      WFDateFormatStyle: 'ISO 8601', WFISO8601IncludeTime: true }, 'Received At');
    const stamp = add('text.replace', { WFInput: text(receivedAt), WFReplaceTextFind: '[^0-9]',
      WFReplaceTextReplace: '', WFReplaceTextRegularExpression: true }, 'Timestamp');
    const random = () => add('number.random', { WFRandomNumberMinimum: 1,
      WFRandomNumberMaximum: 2147483647 }, 'Random Number');
    groupId = add('gettext', { WFTextActionText: text('line-', stamp, '-', random(), '-', random()) }, 'Request ID');
    transcript = add('gettext', { WFTextActionText: text(
      '付款帳戶：LINE。收到通知時間：', receivedAt,
      '\n以下是 LINE 錢包付款完成通知原文：\n', notification,
    ) }, 'Transcript');
    if (!simple) {
      const pending = add('dictionary', { WFItems: dictionary({ groupId, transcript }) }, 'Dictionary');
      const json = add('detect.text', { WFInput: pending }, 'Text');
      add('file.createfolder', { WFFilePath: '小帳LINE待送出' }, 'Folder');
      pendingFile = add('documentpicker.save', { WFInput: json, WFAskWhereToSave: false,
        WFSaveFileOverwrite: false, WFFileDestinationPath: text('小帳LINE待送出/', groupId, '.json') }, 'Saved File');
    }
  }
  if (!simple) {
    requireMatch(groupId, '^line-[0-9]{14,24}-[0-9]{1,10}-[0-9]{1,10}$', '送出識別碼不正確，請保留原待送 JSON 檔，沒有送出。');
    requireMatch(transcript, '付款完成', '待送資料不是付款完成通知，沒有送出。');
  }
  const encoded = add('text.replace', { WFInput: text(binding), WFReplaceTextFind: '^.*#bind=',
    WFReplaceTextReplace: '', WFReplaceTextRegularExpression: true }, 'Encoded Binding');
  const base64a = add('text.replace', { WFInput: text(encoded), WFReplaceTextFind: '-', WFReplaceTextReplace: '+' });
  const base64b = add('text.replace', { WFInput: text(base64a), WFReplaceTextFind: '_', WFReplaceTextReplace: '/' });
  const decoded = add('base64encode', { WFInput: base64b, WFEncodeMode: 'Decode' }, 'Decoded Binding');
  const config = add('detect.dictionary', { WFInput: decoded }, 'Dictionary');
  const endpoint = value(config, 'endpoint');
  const token = value(config, 'proxyToken');
  // Never send the private token to an arbitrary URL supplied by a file/link.
  requireMatch(endpoint, '^https://script\\.google\\.com/macros/s/[A-Za-z0-9_-]+/exec$', '請貼入小帳的完整綁定連結，未送出通知。');
  if (!simple) requireMatch(token, '^.{1,300}$', '綁定連結缺少通行碼，待送檔已保留。');
  const post = fields => add('downloadurl', { WFURL: text(endpoint), WFHTTPMethod: 'POST',
    WFHTTPBodyType: 'JSON', WFJSONValues: dictionary(fields) }, 'Response');
  if (!simple) {
    const capabilities = post({ action: 'getLedgerCapabilities', proxyToken: token });
    const version = value(value(capabilities, 'data'), 'lineNotificationVersion');
    requireMatch(version, '^1$', '請先更新並重新部署 GAS。通知已保留在待送檔，尚未記帳。');
  }
  const response = post({ action: 'enqueueSpokenEntry', proxyToken: token, groupId, transcript });
  if (!simple) {
    // Also require the exact queue ID, rather than accepting an unrelated {ok:true}.
    const queueId = value(value(response, 'data'), 'queueId');
    const expectedId = add('gettext', { WFTextActionText: text('^multi:', groupId, ':1$') });
    const matches = add('text.match', { text: text(queueId), WFMatchTextPattern: text(expectedId) });
    const count = add('count', { WFInput: matches, Input: matches, WFCountType: 'Items' }, 'Count');
    requireMatch(count, '^1$', '回傳識別碼不符，待送檔已保留。');
    add('file.delete', { WFInput: pendingFile, WFDeleteImmediatelyDelete: true });
    add('gettext', { WFTextActionText: '通知已送交小帳審查，尚未完成分類。' });
  }
  return {
    WFWorkflowName: simple ? '小帳LINE簡單記帳' : retry ? '小帳LINE重送' : '小帳LINE通知記帳',
    WFWorkflowActions: actions,
    // OS 27 portable carrier. App tokens/filter pickers are device-local;
    // select LINE and the two filters on the iPhone rather than fabricating them.
    ...(simple ? { WFWorkflowTriggers: [{ WFTriggerIdentifier: 'WFNotificationTrigger',
      WFTriggerSerializedParameters: {}, WFTriggerUUID: randomUUID().toUpperCase() }] } : {}),
    WFWorkflowClientVersion: '4528.0.4.2', WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900', WFWorkflowHasShortcutInputVariables: !retry,
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4292093695, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowInputContentItemClasses: ['WFStringContentItem'], WFWorkflowTypes: [],
    WFWorkflowImportQuestions: [{ Category: 'Parameter', ParameterKey: 'WFTextActionText',
      ActionIndex: bindingIndex, Text: '貼上小帳設定 → 綁定手機 → 複製綁定連結。不要貼到聊天，也不要分享設定後的捷徑。', DefaultValue: '' }],
  };
}

const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function plist(value) {
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, item]) => `<key>${escapeXml(key)}</key>${plist(item)}`).join('')}</dict>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv.slice(2).find(argument => !argument.startsWith('--'))
    || join(dirname(fileURLToPath(import.meta.url)), 'dist');
  mkdirSync(destination, { recursive: true });
  const variants = process.argv.includes('--simple') ? [[false, true]] : [[false, false], [true, false]];
  for (const [retry, simple] of variants) {
    const workflow = makeShortcut(retry, simple);
    const unsigned = join(destination, `${workflow.WFWorkflowName}.unsigned.shortcut`);
    const signed = join(destination, `${workflow.WFWorkflowName}.shortcut`);
    writeFileSync(unsigned, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${plist(workflow)}</plist>`);
    execFileSync('plutil', ['-lint', unsigned], { stdio: 'inherit' });
    execFileSync('plutil', ['-convert', 'binary1', unsigned]);
    execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed], { stdio: 'inherit' });
    unlinkSync(unsigned);
  }
}
