export interface BrowserRuntimeConfig {
  apiBaseUrl?: string;
  wsBaseUrl?: string;
  desktop?: boolean;
}

export interface RuntimeProviderOverride {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface RuntimeOverrides {
  apiBaseUrl: string;
  primary: RuntimeProviderOverride;
  ocr: RuntimeProviderOverride;
  embedding: RuntimeProviderOverride;
}

declare global {
  interface Window {
    __KNOWLEDGE_IDE_CONFIG__?: BrowserRuntimeConfig;
  }
}

const RUNTIME_OVERRIDES_STORAGE_KEY = 'cognition.runtime.overrides';
const RUNTIME_OVERRIDES_EVENT = 'cognition:runtime-overrides-changed';
const ENV_DEFAULT_CHAT_MODEL =
  (import.meta.env.VITE_DEFAULT_MODEL as string | undefined) || 'Pro/MiniMaxAI/MiniMax-M2.5';

const emptyProviderOverride = (): RuntimeProviderOverride => ({
  apiKey: '',
  baseUrl: '',
  model: '',
});

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getBrowserOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.origin;
}

function normalizeApiBase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimTrailingSlash(trimmed);
}

function toWebSocketBase(apiBase: string): string {
  if (apiBase.startsWith('https://')) return apiBase.replace('https://', 'wss://');
  if (apiBase.startsWith('http://')) return apiBase.replace('http://', 'ws://');

  const browserOrigin = getBrowserOrigin();
  if (browserOrigin) {
    const wsOrigin = browserOrigin.replace(/^http/, 'ws');
    if (!apiBase) return wsOrigin;
    if (apiBase.startsWith('/')) return wsOrigin;
  }

  return 'ws://127.0.0.1:8000';
}

function normalizeProviderOverride(value: Partial<RuntimeProviderOverride> | null | undefined): RuntimeProviderOverride {
  return {
    apiKey: String(value?.apiKey || '').trim(),
    baseUrl: String(value?.baseUrl || '').trim(),
    model: String(value?.model || '').trim(),
  };
}

function getDefaultRuntimeOverrides(): RuntimeOverrides {
  return {
    apiBaseUrl: '',
    primary: emptyProviderOverride(),
    ocr: emptyProviderOverride(),
    embedding: emptyProviderOverride(),
  };
}

function getStoredRuntimeOverrides(): RuntimeOverrides {
  if (typeof window === 'undefined') {
    return getDefaultRuntimeOverrides();
  }

  const raw = window.localStorage.getItem(RUNTIME_OVERRIDES_STORAGE_KEY);
  if (!raw) {
    return getDefaultRuntimeOverrides();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeOverrides>;
    return {
      apiBaseUrl: String(parsed.apiBaseUrl || '').trim(),
      primary: normalizeProviderOverride(parsed.primary),
      ocr: normalizeProviderOverride(parsed.ocr),
      embedding: normalizeProviderOverride(parsed.embedding),
    };
  } catch {
    return getDefaultRuntimeOverrides();
  }
}

function resolveRuntimeConfig(overrides?: Partial<RuntimeOverrides>) {
  const browserConfig = typeof window !== 'undefined' ? window.__KNOWLEDGE_IDE_CONFIG__ : undefined;
  const envApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const browserOrigin = getBrowserOrigin();
  const normalizedOverrideApiBase = normalizeApiBase(String(overrides?.apiBaseUrl || ''));

  const resolvedApiBase = normalizeApiBase(
    normalizedOverrideApiBase || browserConfig?.apiBaseUrl || envApiBase || (browserOrigin ? '' : 'http://127.0.0.1:8000')
  );

  const resolvedWsBase = trimTrailingSlash(
    normalizedOverrideApiBase
      ? toWebSocketBase(resolvedApiBase)
      : browserConfig?.wsBaseUrl
        ? normalizeApiBase(browserConfig.wsBaseUrl)
        : toWebSocketBase(resolvedApiBase)
  );

  return {
    apiBaseUrl: resolvedApiBase,
    wsBaseUrl: resolvedWsBase,
    isDesktop: Boolean(browserConfig?.desktop || import.meta.env.VITE_DESKTOP_MODE === 'true'),
  };
}

export function getRuntimeOverrides(): RuntimeOverrides {
  return getStoredRuntimeOverrides();
}

export function saveRuntimeOverrides(overrides: RuntimeOverrides) {
  if (typeof window === 'undefined') return;

  const normalized: RuntimeOverrides = {
    apiBaseUrl: String(overrides.apiBaseUrl || '').trim(),
    primary: normalizeProviderOverride(overrides.primary),
    ocr: normalizeProviderOverride(overrides.ocr),
    embedding: normalizeProviderOverride(overrides.embedding),
  };

  window.localStorage.setItem(RUNTIME_OVERRIDES_STORAGE_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent(RUNTIME_OVERRIDES_EVENT, { detail: normalized }));
}

export function subscribeToRuntimeOverrides(callback: () => void) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleChange = () => callback();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === RUNTIME_OVERRIDES_STORAGE_KEY) {
      callback();
    }
  };

  window.addEventListener(RUNTIME_OVERRIDES_EVENT, handleChange);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(RUNTIME_OVERRIDES_EVENT, handleChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function getRuntimeConfig() {
  return resolveRuntimeConfig(getStoredRuntimeOverrides());
}

export function getApiBaseUrl() {
  return getRuntimeConfig().apiBaseUrl;
}

export function getWsBaseUrl() {
  return getRuntimeConfig().wsBaseUrl;
}

export function getDefaultChatModel() {
  return getStoredRuntimeOverrides().primary.model || ENV_DEFAULT_CHAT_MODEL;
}

export function getRuntimeRequestHeaders() {
  const overrides = getStoredRuntimeOverrides();
  const headers: Record<string, string> = {};

  if (overrides.primary.apiKey) headers['X-Cognition-Primary-Api-Key'] = overrides.primary.apiKey;
  if (overrides.primary.baseUrl) headers['X-Cognition-Primary-Base-Url'] = overrides.primary.baseUrl;
  if (overrides.primary.model) headers['X-Cognition-Primary-Model'] = overrides.primary.model;

  if (overrides.ocr.apiKey) headers['X-Cognition-Ocr-Api-Key'] = overrides.ocr.apiKey;
  if (overrides.ocr.baseUrl) headers['X-Cognition-Ocr-Base-Url'] = overrides.ocr.baseUrl;
  if (overrides.ocr.model) headers['X-Cognition-Ocr-Model'] = overrides.ocr.model;

  if (overrides.embedding.apiKey) headers['X-Cognition-Embedding-Api-Key'] = overrides.embedding.apiKey;
  if (overrides.embedding.baseUrl) headers['X-Cognition-Embedding-Base-Url'] = overrides.embedding.baseUrl;
  if (overrides.embedding.model) headers['X-Cognition-Embedding-Model'] = overrides.embedding.model;

  return headers;
}

export const runtimeConfig = resolveRuntimeConfig();
