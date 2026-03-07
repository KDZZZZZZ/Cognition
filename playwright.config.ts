import { defineConfig } from '@playwright/test';

const requestedWorkers = Number(process.env.E2E_WORKERS || '');
const realLlmMode = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

export default defineConfig({
  testDir: './e2e-tests',
  timeout: 5 * 60 * 1000,
  workers: Number.isFinite(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : realLlmMode
      ? 1
      : undefined,
  expect: {
    timeout: 15 * 1000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  reporter: [['list']],
});
