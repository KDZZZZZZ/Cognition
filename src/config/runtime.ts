interface BrowserRuntimeConfig {
  apiBaseUrl?: string;
  wsBaseUrl?: string;
  desktop?: boolean;
}

declare global {
  interface Window {
    __KNOWLEDGE_IDE_CONFIG__?: BrowserRuntimeConfig;
  }
}

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

const browserConfig = typeof window !== 'undefined' ? window.__KNOWLEDGE_IDE_CONFIG__ : undefined;
const envApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
const browserOrigin = getBrowserOrigin();

const resolvedApiBase = normalizeApiBase(
  browserConfig?.apiBaseUrl || envApiBase || (browserOrigin ? '' : 'http://127.0.0.1:8000')
);

const resolvedWsBase = trimTrailingSlash(
  browserConfig?.wsBaseUrl ? normalizeApiBase(browserConfig.wsBaseUrl) : toWebSocketBase(resolvedApiBase)
);

export const runtimeConfig = {
  apiBaseUrl: resolvedApiBase,
  wsBaseUrl: resolvedWsBase,
  isDesktop: Boolean(browserConfig?.desktop || import.meta.env.VITE_DESKTOP_MODE === 'true'),
};
