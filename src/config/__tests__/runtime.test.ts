import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtimeConfig', () => {
  afterEach(() => {
    delete (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__;
    vi.resetModules();
  });

  it('uses browser injected config when provided', async () => {
    (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__ = {
      apiBaseUrl: 'https://example.com/',
      wsBaseUrl: 'wss://ws.example.com/',
      desktop: true,
    };

    const mod = await import('../runtime');
    expect(mod.runtimeConfig.apiBaseUrl).toBe('https://example.com');
    expect(mod.runtimeConfig.wsBaseUrl).toBe('wss://ws.example.com');
    expect(mod.runtimeConfig.isDesktop).toBe(true);
  });

  it('falls back to browser origin based websocket url', async () => {
    const mod = await import('../runtime');
    expect(typeof mod.runtimeConfig.apiBaseUrl).toBe('string');
    expect(mod.runtimeConfig.wsBaseUrl.startsWith('ws://') || mod.runtimeConfig.wsBaseUrl.startsWith('wss://')).toBe(true);
  });

  it('maps relative api base to browser websocket origin', async () => {
    (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__ = {
      apiBaseUrl: '/api',
    };

    const mod = await import('../runtime');
    const expectedWs = window.location.origin.replace(/^http/, 'ws');
    expect(mod.runtimeConfig.apiBaseUrl).toBe('/api');
    expect(mod.runtimeConfig.wsBaseUrl).toBe(expectedWs);
  });

  it('uses browser origin websocket when api base is blank', async () => {
    (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__ = {
      apiBaseUrl: '/',
    };

    const mod = await import('../runtime');
    const expectedWs = window.location.origin.replace(/^http/, 'ws');
    expect(mod.runtimeConfig.apiBaseUrl).toBe('');
    expect(mod.runtimeConfig.wsBaseUrl).toBe(expectedWs);
  });

  it('falls back to localhost websocket when api base is non-http absolute token', async () => {
    (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__ = {
      apiBaseUrl: 'internal-api-host',
    };

    const mod = await import('../runtime');
    expect(mod.runtimeConfig.apiBaseUrl).toBe('internal-api-host');
    expect(mod.runtimeConfig.wsBaseUrl).toBe('ws://127.0.0.1:8000');
  });
});
