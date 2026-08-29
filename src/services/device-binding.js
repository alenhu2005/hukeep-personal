const DEVICE_TOKEN_KEY = 'hukeep_device_binding_token_v1';
const DEVICE_ENDPOINT_KEY = 'hukeep_device_binding_endpoint_v1';
const LEGACY_TOKEN_KEY = 'hukeep_proxy_token';
const LEGACY_ENDPOINT_KEY = 'hukeep_proxy_endpoint';

function clean(value) {
  return String(value ?? '').trim();
}

function safeGet(storage, key) {
  try {
    return clean(storage?.getItem(key));
  } catch {
    return '';
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // The caller can still use the in-memory values for the current action.
  }
}

function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
}

function validCredentials(value) {
  const endpoint = clean(value?.endpoint);
  const proxyToken = clean(value?.proxyToken);
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  if (!proxyToken || proxyToken.length > 300) return null;
  return { endpoint, proxyToken, bound: true };
}

export function createDeviceBindingPayload(credentials) {
  const normalized = validCredentials(credentials);
  if (!normalized) throw new Error('裝置綁定資料不完整');
  return encodeBase64Url(JSON.stringify({
    v: 1,
    endpoint: normalized.endpoint,
    proxyToken: normalized.proxyToken,
  }));
}

export function parseDeviceBindingHash(hash) {
  const match = String(hash ?? '').match(/^#bind=([A-Za-z0-9_-]{16,4096})$/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(match[1]));
    if (parsed?.v !== 1) return null;
    return validCredentials(parsed);
  } catch {
    return null;
  }
}

export function createDeviceBindingStore(storage, legacySessionStorage) {
  function read() {
    let endpoint = safeGet(storage, DEVICE_ENDPOINT_KEY);
    let proxyToken = safeGet(storage, DEVICE_TOKEN_KEY);
    const legacyEndpoint = safeGet(legacySessionStorage, LEGACY_ENDPOINT_KEY);
    const legacyToken = safeGet(legacySessionStorage, LEGACY_TOKEN_KEY);

    endpoint = endpoint || legacyEndpoint;
    proxyToken = proxyToken || legacyToken;
    if (endpoint && proxyToken && (!safeGet(storage, DEVICE_ENDPOINT_KEY) || !safeGet(storage, DEVICE_TOKEN_KEY))) {
      safeSet(storage, DEVICE_ENDPOINT_KEY, endpoint);
      safeSet(storage, DEVICE_TOKEN_KEY, proxyToken);
    }
    return { endpoint, proxyToken, bound: Boolean(endpoint && proxyToken) };
  }

  function remember(value) {
    const endpoint = clean(value?.endpoint);
    const proxyToken = clean(value?.proxyToken);
    if (!endpoint || !proxyToken) return { endpoint, proxyToken, bound: false };
    safeSet(storage, DEVICE_ENDPOINT_KEY, endpoint);
    safeSet(storage, DEVICE_TOKEN_KEY, proxyToken);
    return { endpoint, proxyToken, bound: true };
  }

  return { read, remember };
}
