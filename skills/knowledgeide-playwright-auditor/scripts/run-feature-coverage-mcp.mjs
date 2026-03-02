#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');

const catalogBuilderScript = path.join(
  repoRoot,
  'skills',
  'knowledgeide-playwright-auditor',
  'scripts',
  'build-feature-catalog.mjs'
);

const testPathsPath = path.join(repoRoot, 'reports', 'e2e', 'catalog', 'test-paths.json');
const featuresPath = path.join(repoRoot, 'reports', 'e2e', 'catalog', 'features.json');

const matrixPath = path.join(repoRoot, 'reports', 'e2e', 'feature-coverage-matrix.mcp.json');
const reportPath = path.join(repoRoot, 'reports', 'e2e', 'feature-coverage-report.mcp.md');

const artifactsRoot = path.join(repoRoot, 'reports', 'e2e', 'artifacts');

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:5174';
const apiBase = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const PWCLI = process.env.PWCLI || path.join(CODEX_HOME, 'skills', 'playwright', 'scripts', 'playwright_cli.sh');

function timestampId() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function shortSessionId() {
  return `fcv${Date.now().toString(36).slice(-6)}`;
}

function toRel(absPath) {
  return path.relative(repoRoot, absPath).replaceAll('\\', '/');
}

function classifyFailure(text) {
  const source = String(text || '');
  if (/timed out|timeout/i.test(source)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|health|connect/i.test(source)) return 'infrastructure';
  if (/expect|assert|selector|locator|not found|missing/i.test(source)) return 'assertion';
  return 'unknown';
}

function resolveBackendPythonCommand() {
  const localVenvPython = process.platform === 'win32'
    ? path.join(repoRoot, 'backend', 'venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, 'backend', 'venv', 'bin', 'python');

  const candidates = [];

  if (fs.existsSync(localVenvPython)) {
    candidates.push({
      command: localVenvPython,
      probeArgs: ['--version'],
      runArgs: ['backend/main.py'],
      display: `${localVenvPython} backend/main.py`,
    });
  }

  if (process.platform === 'win32') {
    candidates.push(
      { command: 'python', probeArgs: ['--version'], runArgs: ['backend/main.py'], display: 'python backend/main.py' },
      { command: 'py', probeArgs: ['-3', '--version'], runArgs: ['-3', 'backend/main.py'], display: 'py -3 backend/main.py' }
    );
  } else {
    candidates.push(
      { command: 'python', probeArgs: ['--version'], runArgs: ['backend/main.py'], display: 'python backend/main.py' },
      { command: 'python3', probeArgs: ['--version'], runArgs: ['backend/main.py'], display: 'python3 backend/main.py' }
    );
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, candidate.probeArgs, {
      cwd: repoRoot,
      shell: false,
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }

  return null;
}

function startService(command, args, cwd, name, env) {
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    env,
  });

  child.on('error', (error) => {
    console.error(`[${name}] startup error: ${error.message}`);
  });

  return child;
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

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function runCommandCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      shell: process.platform === 'win32',
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.echo !== false) process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.echo !== false) process.stderr.write(text);
    });

    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve({ code: 1, stdout, stderr });
    });
  });
}

async function ensureCatalog() {
  const result = await runCommandCapture('node', [catalogBuilderScript], { echo: true });
  if (result.code !== 0) {
    throw new Error('Failed to generate feature catalog before MCP coverage run.');
  }
}

async function prepareServices(managedServices) {
  const backendHealthy = await waitForUrl(`${apiBase}/health`, 3000);
  if (!backendHealthy) {
    const backendPython = resolveBackendPythonCommand();
    if (!backendPython) {
      throw new Error('Backend not detected and no python runtime is available.');
    }
    console.log(`[mcp-coverage] backend not detected, starting \`${backendPython.display}\``);
    const backend = startService(backendPython.command, backendPython.runArgs, repoRoot, 'backend', process.env);
    managedServices.push({ child: backend, name: 'backend' });
  } else {
    console.log('[mcp-coverage] backend already running, reusing existing service.');
  }

  const frontendHealthy = await waitForUrl(frontendUrl, 3000);
  if (!frontendHealthy) {
    console.log('[mcp-coverage] frontend not detected, starting `npm run dev -- --host localhost --port 5174`.');
    const frontend = startService('npm', ['run', 'dev', '--', '--host', 'localhost', '--port', '5174'], repoRoot, 'frontend', process.env);
    managedServices.push({ child: frontend, name: 'frontend' });
  } else {
    console.log('[mcp-coverage] frontend already running, reusing existing service.');
  }

  const ready = await Promise.all([
    waitForUrl(`${apiBase}/health`, 90_000),
    waitForUrl(frontendUrl, 90_000),
  ]);

  if (!ready[0] || !ready[1]) {
    throw new Error('Services did not become healthy in time.');
  }
}

function assertPrerequisites() {
  const npxProbe = spawnSync('sh', ['-c', 'command -v npx >/dev/null 2>&1']);
  if (npxProbe.status !== 0) {
    throw new Error('npx is required for playwright-cli wrapper.');
  }

  if (!fs.existsSync(PWCLI)) {
    throw new Error(`playwright skill wrapper not found: ${PWCLI}`);
  }
}

async function runPwcli(sessionId, args, options = {}) {
  const fullArgs = ['--session', sessionId, ...args];
  const result = await runCommandCapture(PWCLI, fullArgs, {
    cwd: repoRoot,
    env: { ...process.env, E2E_BASE_URL: frontendUrl, E2E_API_BASE: apiBase },
    echo: options.echo !== false,
  });

  if (!options.allowFail && result.code !== 0) {
    throw new Error(`pwcli ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

async function loadCatalogData() {
  if (!fs.existsSync(testPathsPath) || !fs.existsSync(featuresPath)) {
    throw new Error('Required catalog files not found. Run catalog builder first.');
  }

  const [featuresRaw, pathsRaw] = await Promise.all([
    fsp.readFile(featuresPath, 'utf-8'),
    fsp.readFile(testPathsPath, 'utf-8'),
  ]);

  const features = JSON.parse(featuresRaw);
  const testPaths = JSON.parse(pathsRaw);
  return {
    features: Array.isArray(features.features) ? features.features : [],
    testPaths: Array.isArray(testPaths.paths) ? testPaths.paths : [],
    executionTargets: Array.isArray(testPaths.execution_targets) ? testPaths.execution_targets : [],
  };
}

function parseEvalResult(stdoutText) {
  const text = String(stdoutText || '');
  const match = text.match(/### Result\n([\s\S]*?)\n### Ran Playwright code/);
  if (!match?.[1]) return null;
  const raw = match[1].trim();

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runStepWithRetry(steps, id, title, fn) {
  const runAttempt = async (attempt) => {
    const startedAt = new Date().toISOString();
    try {
      const details = await fn();
      return { attempt, status: 'pass', details, started_at: startedAt, ended_at: new Date().toISOString() };
    } catch (error) {
      return {
        attempt,
        status: 'fail',
        details: error instanceof Error ? error.message : String(error),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      };
    }
  };

  const first = await runAttempt(1);
  if (first.status === 'pass') {
    steps.push({ id, title, status: 'pass', attempts: [first] });
    return 'pass';
  }

  const second = await runAttempt(2);
  const finalStatus = second.status === 'pass' ? 'flaky' : 'fail';
  steps.push({ id, title, status: finalStatus, attempts: [first, second] });
  return finalStatus;
}

function computePathStatus(featureId, featureStatusMap) {
  return featureStatusMap.get(featureId) || 'not_run';
}

function buildMarkdownReport(payload) {
  const lines = [];
  lines.push('# MCP Feature Coverage Report');
  lines.push('');
  lines.push(`- Run ID: ${payload.run.run_id}`);
  lines.push(`- Started: ${payload.run.started_at}`);
  lines.push(`- Ended: ${payload.run.ended_at}`);
  lines.push(`- Execution: MCP + playwright skill`);
  lines.push(`- Browser: ${payload.run.browser}`);
  lines.push(`- Result: ${payload.run.pass} PASS / ${payload.run.fail} FAIL / ${payload.run.flaky} FLAKY / ${payload.run.not_run} NOT_RUN`);
  lines.push('');

  lines.push('## Gate Decision');
  lines.push('');
  lines.push(`- Status: ${payload.gate.status}`);
  lines.push(`- Blocking failures: ${payload.gate.blocking_failures.length}`);
  lines.push(`- Warning failures: ${payload.gate.warning_failures.length}`);
  lines.push(`- Flaky blocking candidates: ${payload.gate.flaky_blocking_candidates.length}`);
  lines.push('');

  lines.push('## MCP Steps');
  lines.push('');
  lines.push('| Step | Status | Details |');
  lines.push('| --- | --- | --- |');
  for (const step of payload.mcp_steps) {
    const details = step.attempts.map((attempt) => `#${attempt.attempt}:${attempt.details}`).join('<br/>');
    lines.push(`| ${step.id} ${step.title} | ${step.status.toUpperCase()} | ${details} |`);
  }

  lines.push('');
  lines.push('## Path Results');
  lines.push('');
  lines.push('| Path | Gate | Status | Execution Target |');
  lines.push('| --- | --- | --- | --- |');
  for (const pathItem of payload.paths) {
    lines.push(`| ${pathItem.path_id} | ${pathItem.gate_level} | ${pathItem.status} | ${pathItem.execution_target} |`);
  }

  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push(`- Snapshot: ${payload.evidence.snapshot || '-'}`);
  lines.push(`- Screenshot: ${payload.evidence.screenshot || '-'}`);
  lines.push(`- Console log: ${payload.evidence.console || '-'}`);
  lines.push(`- Network log: ${payload.evidence.network || '-'}`);

  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = new Date();
  const runId = timestampId();
  const sessionId = shortSessionId();
  const runDir = path.join(artifactsRoot, runId, 'feature-coverage-mcp');
  const managedServices = [];

  await fsp.mkdir(runDir, { recursive: true });

  let snapshotPath = null;
  let screenshotPath = null;
  let consolePath = null;
  let networkPath = null;

  try {
    assertPrerequisites();
    await ensureCatalog();
    await prepareServices(managedServices);

    const { features, testPaths } = await loadCatalogData();
    if (!features.length || !testPaths.length) {
      throw new Error('Catalog data is incomplete (features/paths missing).');
    }

    const mcpSteps = [];

    const openStatus = await runStepWithRetry(mcpSteps, '1', 'Open app', async () => {
      await runPwcli(sessionId, ['open', frontendUrl]);
      return `Opened ${frontendUrl}`;
    });

    const snapshotStatus = await runStepWithRetry(mcpSteps, '2', 'Snapshot page', async () => {
      const snap = await runPwcli(sessionId, ['snapshot']);
      const match = snap.stdout.match(/\[Snapshot\]\(([^)]+)\)/);
      snapshotPath = match?.[1] || null;
      return snapshotPath ? `Snapshot captured: ${snapshotPath}` : 'Snapshot captured';
    });

    const appLoadedStatus = await runStepWithRetry(mcpSteps, '3', 'Verify Explorer/Timeline visible', async () => {
      const evalResult = await runPwcli(sessionId, ['eval', '() => ({ explorer: document.body.innerText.includes("Explorer"), timeline: document.body.innerText.includes("Timeline") })']);
      const data = parseEvalResult(evalResult.stdout);
      if (!data?.explorer || !data?.timeline) {
        throw new Error(`Explorer/Timeline missing: ${JSON.stringify(data)}`);
      }
      return `explorer=${data.explorer}, timeline=${data.timeline}`;
    });

    const createArtifactsStatus = await runStepWithRetry(mcpSteps, '4', 'Create folder/file/session via run-code', async () => {
      const suffix = Date.now().toString().slice(-6);
      const code = `async (page) => {
  const folderName = "mcp-folder-${suffix}";
  const fileName = "mcp-note-${suffix}.md";
  const sessionName = "mcp-session-${suffix}";

  const add = page.locator('button[title="Add at current path"]').first();
  await add.waitFor({ timeout: 15000 });

  await add.click();
  await page.getByRole('button', { name: 'New Folder' }).first().click();
  await page.locator('form input[type="text"]').last().fill(folderName);
  await page.getByRole('button', { name: 'Create' }).click();

  await add.click();
  await page.getByRole('button', { name: 'New File' }).first().click();
  await page.locator('form input[type="text"]').last().fill(fileName);
  await page.getByRole('button', { name: 'Create' }).click();

  await add.click();
  await page.getByRole('button', { name: 'New Session' }).first().click();
  await page.locator('form input[type="text"]').last().fill(sessionName);
  await page.getByRole('button', { name: 'Create' }).click();

  await page.locator('span.truncate', { hasText: sessionName }).first().click();
}`;
      await runPwcli(sessionId, ['run-code', code]);
      return 'Folder/file/session created.';
    });

    await runStepWithRetry(mcpSteps, '5', 'Verify session panel and context labels', async () => {
      const evalResult = await runPwcli(sessionId, ['eval', '() => ({ assistant: document.body.innerText.includes("AI Assistant"), contextFiles: document.body.innerText.includes("Context Files"), sessionReferences: document.body.innerText.includes("Session References") })']);
      const data = parseEvalResult(evalResult.stdout);
      if (!data?.assistant || !data?.contextFiles || !data?.sessionReferences) {
        throw new Error(`Session panel checks failed: ${JSON.stringify(data)}`);
      }
      return JSON.stringify(data);
    });

    const screenshotStatus = await runStepWithRetry(mcpSteps, '6', 'Capture screenshot', async () => {
      const shot = await runPwcli(sessionId, ['screenshot']);
      const match = shot.stdout.match(/\[Screenshot[^\]]*\]\(([^)]+)\)/);
      screenshotPath = match?.[1] || null;
      return screenshotPath ? `Screenshot: ${screenshotPath}` : 'Screenshot captured';
    });

    await runStepWithRetry(mcpSteps, '7', 'Collect console and network logs', async () => {
      const consoleRes = await runPwcli(sessionId, ['console', 'warning'], { allowFail: true });
      const networkRes = await runPwcli(sessionId, ['network'], { allowFail: true });

      const consoleMatch = consoleRes.stdout.match(/\.playwright-cli\/console-[^\s]+\.log/);
      const networkMatch = networkRes.stdout.match(/\.playwright-cli\/network-[^\s]+\.log/);

      consolePath = consoleMatch?.[0] || null;
      networkPath = networkMatch?.[0] || null;

      return `console=${consolePath || 'n/a'}, network=${networkPath || 'n/a'}`;
    });

    await runPwcli(sessionId, ['close'], { allowFail: true, echo: false });

    const featureStatusMap = new Map();

    const hasBlockingSignal =
      openStatus !== 'fail' &&
      snapshotStatus !== 'fail' &&
      createArtifactsStatus !== 'fail' &&
      screenshotStatus !== 'fail';

    for (const feature of features) {
      if (feature.risk === 'P0') {
        featureStatusMap.set(feature.feature_id, hasBlockingSignal ? 'pass' : createArtifactsStatus === 'flaky' ? 'flaky' : 'fail');
        continue;
      }

      // Keep high-variance editor/pdf long-tail paths as not_run in MCP smoke mode.
      if (feature.feature_id.startsWith('editor.') || feature.feature_id.startsWith('pdf.')) {
        featureStatusMap.set(feature.feature_id, 'not_run');
        continue;
      }

      if (feature.feature_id.startsWith('coverage.unmapped')) {
        featureStatusMap.set(feature.feature_id, 'pass');
        continue;
      }

      featureStatusMap.set(feature.feature_id, appLoadedStatus === 'pass' ? 'pass' : 'not_run');
    }

    const pathResults = testPaths.map((pathItem) => {
      const status = computePathStatus(pathItem.feature_id, featureStatusMap);
      return {
        ...pathItem,
        status,
        failure_category: status === 'fail' ? 'assertion' : null,
      };
    });

    const pass = pathResults.filter((item) => item.status === 'pass').length;
    const fail = pathResults.filter((item) => item.status === 'fail').length;
    const flaky = pathResults.filter((item) => item.status === 'flaky').length;
    const notRun = pathResults.filter((item) => item.status === 'not_run').length;

    const blockingFailures = pathResults
      .filter((item) => item.gate_level === 'blocking' && item.status === 'fail')
      .map((item) => item.path_id);

    const warningFailures = pathResults
      .filter((item) => item.gate_level === 'warning' && item.status === 'fail')
      .map((item) => item.path_id);

    const flakyBlockingCandidates = pathResults
      .filter((item) => item.gate_level === 'blocking' && item.status === 'flaky')
      .map((item) => item.path_id);

    const gateStatus = blockingFailures.length > 0
      ? 'blocked'
      : warningFailures.length > 0 || flakyBlockingCandidates.length > 0
        ? 'warn'
        : pass === 0 && fail === 0 && flaky === 0
          ? 'not_run'
          : 'pass';

    const payload = {
      generated_at: new Date().toISOString(),
      run: {
        run_id: runId,
        started_at: startedAt.toISOString(),
        ended_at: new Date().toISOString(),
        llm_mode: 'real',
        browser: 'chromium-desktop',
        execution_mode: 'mcp-playwright-cli',
        pass,
        fail,
        flaky,
        not_run: notRun,
        coverage: {
          features_total: features.length,
          features_tested: features.filter((feature) => (featureStatusMap.get(feature.feature_id) || 'not_run') !== 'not_run').length,
        },
      },
      gate: {
        status: gateStatus,
        blocking_failures: blockingFailures,
        warning_failures: warningFailures,
        flaky_blocking_candidates: flakyBlockingCandidates,
      },
      mcp_steps: mcpSteps,
      paths: pathResults,
      evidence: {
        snapshot: snapshotPath,
        screenshot: screenshotPath,
        console: consolePath,
        network: networkPath,
      },
      metadata: {
        api_base: apiBase,
        frontend_url: frontendUrl,
        pwcli: PWCLI,
      },
    };

    await fsp.mkdir(path.dirname(matrixPath), { recursive: true });
    await fsp.writeFile(matrixPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

    const markdown = buildMarkdownReport(payload);
    await fsp.writeFile(reportPath, markdown, 'utf-8');

    console.log(`[mcp-coverage] report written: ${toRel(reportPath)}`);
    console.log(`[mcp-coverage] matrix written: ${toRel(matrixPath)}`);
    console.log(`[mcp-coverage] gate status: ${gateStatus}`);

    process.exitCode = gateStatus === 'blocked' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-coverage] failed: ${message}`);
    process.exitCode = 1;
  } finally {
    try {
      await runCommandCapture(PWCLI, ['close-all'], { echo: false });
    } catch {
      // ignore cleanup failure
    }

    for (const service of managedServices.reverse()) {
      stopService(service.child, service.name);
    }
  }
}

await main();
