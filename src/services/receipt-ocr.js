const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function recognizeReceiptImage(file, options = {}) {
  if (!(file instanceof Blob) || !String(file.type).startsWith('image/')) {
    throw new Error('請選擇發票或收據截圖');
  }
  if (file.size > MAX_IMAGE_BYTES) throw new Error('圖片請小於 12 MB');

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(['chi_tra', 'eng'], 1, {
    logger(message) {
      options.onProgress?.({
        status: String(message.status ?? ''),
        progress: Number(message.progress ?? 0),
      });
    },
  });
  try {
    const result = await worker.recognize(file);
    return {
      text: String(result.data?.text ?? ''),
      confidence: Math.min(1, Math.max(0, Number(result.data?.confidence ?? 0) / 100)),
    };
  } finally {
    await worker.terminate();
  }
}
