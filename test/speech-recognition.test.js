import { describe, expect, it } from 'vitest';
import { recognizeSpeechOnce } from '../src/services/speech-recognition.js';

describe('瀏覽器口語辨識', () => {
  it('不支援時提供清楚的 fallback 訊息', async () => {
    await expect(recognizeSpeechOnce({ Recognition: null })).rejects.toThrow('不支援');
  });

  it('以繁體中文辨識一次並回傳逐字稿', async () => {
    class FakeRecognition {
      static async available() {
        return 'available';
      }

      processLocally = false;

      start() {
        expect(this.lang).toBe('zh-TW');
        expect(this.continuous).toBe(false);
        expect(this.interimResults).toBe(false);
        expect(this.processLocally).toBe(true);
        this.onstart?.();
        this.onresult?.({
          results: [{ 0: { transcript: '昨天搭高鐵 1490 元', confidence: 0.92 } }],
        });
      }
    }

    await expect(
      recognizeSpeechOnce({ Recognition: FakeRecognition }),
    ).resolves.toEqual({
      transcript: '昨天搭高鐵 1490 元',
      confidence: 0.92,
      local: true,
    });
  });

  it('將權限拒絕轉成可讀訊息', async () => {
    class DeniedRecognition {
      start() {
        this.onerror?.({ error: 'not-allowed' });
      }
    }

    await expect(
      recognizeSpeechOnce({ Recognition: DeniedRecognition }),
    ).rejects.toThrow('麥克風權限');
  });
});
