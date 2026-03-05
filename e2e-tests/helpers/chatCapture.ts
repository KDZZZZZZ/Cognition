import type { Page, Request as PWRequest, Response as PWResponse } from '@playwright/test';

export interface CapturedExchange {
  kind: 'completion' | 'answer';
  url: string;
  method: string;
  requestBody: any;
  responseStatus?: number;
  responseBody?: any;
  createdAt: string;
  completedAt?: string;
}

export interface ChatCaptureController {
  exchanges: CapturedExchange[];
  waitForExchange: (matcher: (exchange: CapturedExchange) => boolean, timeoutMs?: number) => Promise<CapturedExchange>;
  latestExchange: (matcher?: (exchange: CapturedExchange) => boolean) => CapturedExchange | null;
}

function parseKind(url: string): 'completion' | 'answer' | null {
  if (url.includes('/api/v1/chat/completions')) return 'completion';
  if (/\/api\/v1\/chat\/tasks\/.+\/answer/.test(url)) return 'answer';
  return null;
}

export function installChatCapture(page: Page): ChatCaptureController {
  const exchanges: CapturedExchange[] = [];
  const byRequest = new Map<PWRequest, CapturedExchange>();

  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const kind = parseKind(request.url());
    if (!kind) return;

    let body: any = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData() || null;
    }

    const exchange: CapturedExchange = {
      kind,
      url: request.url(),
      method: request.method(),
      requestBody: body,
      createdAt: new Date().toISOString(),
    };
    exchanges.push(exchange);
    byRequest.set(request, exchange);
  });

  page.on('response', async (response: PWResponse) => {
    const kind = parseKind(response.url());
    if (!kind) return;
    const exchange = byRequest.get(response.request());
    if (!exchange) return;
    exchange.responseStatus = response.status();
    exchange.completedAt = new Date().toISOString();
    try {
      exchange.responseBody = await response.json();
    } catch {
      try {
        exchange.responseBody = await response.text();
      } catch {
        exchange.responseBody = null;
      }
    }
  });

  return {
    exchanges,
    async waitForExchange(matcher, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = [...exchanges].reverse().find((exchange) => matcher(exchange) && exchange.responseBody !== undefined);
        if (found) return found;
        await page.waitForTimeout(200);
      }
      const fallback = [...exchanges].reverse().find((exchange) => matcher(exchange));
      if (fallback) return fallback;
      throw new Error('Timed out waiting for captured chat exchange.');
    },
    latestExchange(matcher) {
      return [...exchanges].reverse().find((exchange) => (matcher ? matcher(exchange) : true)) || null;
    },
  };
}
