import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtimeConfig', () => {
  afterEach(() => {
    delete (window as Window & { __KNOWLEDGE_IDE_CONFIG__?: unknown }).__KNOWLEDGE_IDE_CONFIG__;
    window.localStorage.removeItem('cognition.runtime.overrides');
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

  it('uses stored overrides for runtime config, model, and request headers', async () => {
    window.localStorage.setItem(
      'cognition.runtime.overrides',
      JSON.stringify({
        apiBaseUrl: 'http://127.0.0.1:9000/',
        primary: { apiKey: 'pk-main', baseUrl: 'https://llm.example.com', model: 'kimi-latest' },
        ocr: { apiKey: 'pk-ocr', baseUrl: 'https://ocr.example.com', model: 'ocr-model' },
        embedding: { apiKey: 'pk-embed', baseUrl: 'https://embed.example.com', model: 'embed-model' },
      })
    );

    const mod = await import('../runtime');
    expect(mod.getRuntimeConfig().apiBaseUrl).toBe('http://127.0.0.1:9000');
    expect(mod.getRuntimeConfig().wsBaseUrl).toBe('ws://127.0.0.1:9000');
    expect(mod.getDefaultChatModel()).toBe('kimi-latest');
    expect(mod.getRuntimeRequestHeaders()).toMatchObject({
      'X-Cognition-Primary-Api-Key': 'pk-main',
      'X-Cognition-Ocr-Model': 'ocr-model',
      'X-Cognition-Embedding-Base-Url': 'https://embed.example.com',
    });
  });
});
