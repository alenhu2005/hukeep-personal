const DATABASE_NAME = 'hukeep-receipts-v1';
const STORE_NAME = 'receipts';

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('無法開啟收據儲存空間'));
  });
}

function newReceiptId() {
  return globalThis.crypto?.randomUUID?.() || `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function storeReceipt(file) {
  if (!(file instanceof Blob)) return null;
  const database = await openDatabase();
  if (!database) return null;
  const record = {
    id: newReceiptId(),
    name: String(file.name || '收據截圖').slice(0, 160),
    type: String(file.type || 'image/*').slice(0, 80),
    blob: file,
    savedAt: new Date().toISOString(),
  };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('無法儲存收據截圖'));
    transaction.onabort = () => reject(transaction.error || new Error('無法儲存收據截圖'));
  });
  database.close();
  return { id: record.id, name: record.name };
}

export async function readReceiptUrl(receiptId) {
  if (!receiptId) return '';
  const database = await openDatabase();
  if (!database) return '';
  const record = await new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(receiptId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('無法讀取收據截圖'));
  });
  database.close();
  return record?.blob ? URL.createObjectURL(record.blob) : '';
}

export async function removeReceipt(receiptId) {
  if (!receiptId) return;
  const database = await openDatabase();
  if (!database) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(receiptId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('無法刪除收據截圖'));
  });
  database.close();
}
