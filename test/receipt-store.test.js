import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReceiptUrl, removeReceipt, storeReceipt } from '../src/storage/receipt-store.js';

function createFakeIndexedDb() {
  const records = new Map();
  let created = false;
  function transaction() {
    const tx = {
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore() {
        return {
          put(record) {
            records.set(record.id, record);
            queueMicrotask(() => tx.oncomplete?.());
          },
          get(id) {
            const request = { onsuccess: null, onerror: null, result: null, error: null };
            queueMicrotask(() => {
              request.result = records.get(id) || null;
              request.onsuccess?.();
            });
            return request;
          },
          delete(id) {
            records.delete(id);
            queueMicrotask(() => tx.oncomplete?.());
          },
        };
      },
    };
    return tx;
  }
  return {
    records,
    open() {
      const request = {
        result: {
          objectStoreNames: { contains: () => created },
          createObjectStore() { created = true; },
          transaction,
          close: vi.fn(),
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        error: null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const originalIndexedDb = globalThis.indexedDB;

afterEach(() => {
  if (originalIndexedDb) globalThis.indexedDB = originalIndexedDb;
  else delete globalThis.indexedDB;
});

describe('本機收據截圖', () => {
  it('在 IndexedDB 儲存、讀取與刪除圖片，不可用時安全略過', async () => {
    const fake = createFakeIndexedDb();
    globalThis.indexedDB = fake;
    const file = new File(['receipt'], '午餐.png', { type: 'image/png' });

    const saved = await storeReceipt(file);
    expect(saved).toMatchObject({ name: '午餐.png' });
    expect(fake.records.has(saved.id)).toBe(true);
    await expect(readReceiptUrl(saved.id)).resolves.toMatch(/^blob:/);
    await removeReceipt(saved.id);
    await expect(readReceiptUrl(saved.id)).resolves.toBe('');

    expect(await storeReceipt('not-a-file')).toBeNull();
    delete globalThis.indexedDB;
    await expect(storeReceipt(new Blob(['offline']))).resolves.toBeNull();
    await expect(readReceiptUrl('missing')).resolves.toBe('');
    await expect(removeReceipt('missing')).resolves.toBeUndefined();
  });
});
