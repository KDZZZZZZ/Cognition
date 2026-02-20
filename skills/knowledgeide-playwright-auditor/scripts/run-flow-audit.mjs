#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:5174';
const apiBase = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';
const useRealLlm = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

function runCommand(command, args, cwd, name) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code) => {
      resolveExit(code ?? 1);
    });

    child.on('error', (error) => {
      console.error(`[${name}] failed to start:`, error.message);
      resolveExit(1);
    });
  });
}

function startService(command, args, cwd, name) {
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`[${name}] startup error:`, error.message);
  });

  return child;
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function stopService(child, name) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  console.log(`[${name}] stopped.`);
}

async function main() {
  const managed = [];

  try {
    process.env.E2E_BASE_URL = frontendUrl;
    process.env.E2E_API_BASE = apiBase;
    process.env.E2E_REAL_LLM = useRealLlm ? 'true' : 'false';

    if (useRealLlm) {
      if (!process.env.OPENAI_API_KEY) {
        console.error('[audit] E2E_REAL_LLM=true requires OPENAI_API_KEY in environment.');
        process.exitCode = 1;
        return;
      }
      if (!process.env.OPENAI_BASE_URL) {
        process.env.OPENAI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      }
      if (!process.env.DEFAULT_MODEL) {
        process.env.DEFAULT_MODEL = 'qwen-plus';
      }
      console.log(`[audit] real-llm mode enabled (base=${process.env.OPENAI_BASE_URL}, model=${process.env.DEFAULT_MODEL})`);
    } else {
      console.log('[audit] mock-llm mode enabled (deterministic regression mode).');
    }

    console.log(`[audit] repo root: ${repoRoot}`);

    const backendHealthy = await waitForUrl(`${apiBase}/health`, 3000);
    if (!backendHealthy) {
      console.log('[audit] backend not detected, starting `python backend/main.py`');
      const backend = startService('python', ['backend/main.py'], repoRoot, 'backend');
      managed.push({ child: backend, name: 'backend' });
    } else {
      console.log('[audit] backend already running, reusing existing service.');
    }

    const frontendHealthy = await waitForUrl(frontendUrl, 3000);
    if (!frontendHealthy) {
      console.log('[audit] frontend not detected, starting `npm run dev -- --host localhost --port 5174`');
      const frontend = startService('npm', ['run', 'dev', '--', '--host', 'localhost', '--port', '5174'], repoRoot, 'frontend');
      managed.push({ child: frontend, name: 'frontend' });
    } else {
      console.log('[audit] frontend already running, reusing existing service.');
    }

    const ready = await Promise.all([
      waitForUrl(`${apiBase}/health`, 90_000),
      waitForUrl(frontendUrl, 90_000),
    ]);

    if (!ready[0] || !ready[1]) {
      console.error('[audit] services did not become healthy in time.');
      process.exitCode = 1;
      return;
    }

    // Final backend health check before running Playwright.
    const healthRes = await fetch(`${apiBase}/health`).catch(() => null);
    if (!healthRes || !healthRes.ok) {
      console.error('[audit] backend /health check failed before e2e run.');
      process.exitCode = 1;
      return;
    }

    console.log('[audit] services are healthy, running Playwright full-flow audit...');
    const code = await runCommand(
      'npx',
      ['playwright', 'test', 'e2e-tests/full-flow-audit.spec.ts', '--config=playwright.config.ts'],
      repoRoot,
      'playwright'
    );

    process.exitCode = code;
  } finally {
    for (const service of managed.reverse()) {
      stopService(service.child, service.name);
    }
  }
}

await main();
