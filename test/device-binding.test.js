import { describe, expect, it } from 'vitest';

import {
  createDeviceBindingPayload,
  createDeviceBindingStore,
  parseDeviceBindingHash,
} from '../src/services/device-binding.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

describe('裝置綁定', () => {
  it('將舊版分頁授權自動遷移為長期裝置綁定', () => {
    const storage = memoryStorage();
    const legacySession = memoryStorage({
      hukeep_proxy_endpoint: 'https://script.google.com/macros/s/test/exec',
      hukeep_proxy_token: 'legacy-device-token',
    });
    const binding = createDeviceBindingStore(storage, legacySession);

    expect(binding.read()).toEqual({
      endpoint: 'https://script.google.com/macros/s/test/exec',
      proxyToken: 'legacy-device-token',
      bound: true,
    });
    expect(storage.getItem('hukeep_device_binding_token_v1')).toBe('legacy-device-token');
  });

  it('綁定後直接從裝置讀取，不再依賴當前分頁', () => {
    const storage = memoryStorage();
    const binding = createDeviceBindingStore(storage, memoryStorage());

    binding.remember({
      endpoint: 'https://script.google.com/macros/s/test/exec',
      proxyToken: 'bound-device-token',
    });

    expect(binding.read()).toEqual({
      endpoint: 'https://script.google.com/macros/s/test/exec',
      proxyToken: 'bound-device-token',
      bound: true,
    });
  });

  it('產生可供手機掃描的本機綁定資料，並可從 hash 安全還原', () => {
    const credentials = {
      endpoint: 'https://script.google.com/macros/s/test/exec',
      proxyToken: 'device-token-123',
    };
    const payload = createDeviceBindingPayload(credentials);

    expect(payload).not.toContain(credentials.proxyToken);
    expect(parseDeviceBindingHash(`#bind=${payload}`)).toEqual({
      ...credentials,
      bound: true,
    });
  });

  it('拒絕無效或非 HTTPS 的手機綁定連結', () => {
    expect(parseDeviceBindingHash('#overview')).toBeNull();
    expect(parseDeviceBindingHash('#bind=broken')).toBeNull();
  });
});
