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
const matrixPath = path.join(repoRoot, 'reports', 'e2e', 'feature-coverage-matrix.json');
const reportPath = path.join(repoRoot, 'reports', 'e2e', 'feature-coverage-report.md');
const artifactsRoot = path.join(repoRoot, 'reports', 'e2e', 'artifacts');

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:5174';
const apiBase = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';
const dryRun = process.argv.includes('--dry-run');

function timestampId() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function toRel(absPath) {
  return path.relative(repoRoot, absPath).replaceAll('\\', '/');
}

function classifyFailure(text) {
  const source = String(text || '');
  if (/timed out|timeout/i.test(source)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|health|connect/i.test(source)) return 'infrastructure';
  if (/expect\(|toBe|toHave|assert/i.test(source)) return 'assertion';
  return 'unknown';
}

function flattenArray(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (Array.isArray(item) ? flattenArray(item) : [item]));
}

function parsePlaywrightJson(stdoutText) {
  const text = String(stdoutText || '').trim();
  if (!text) return null;

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function summarizePlaywrightReport(report) {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    failures: [],
  };

  if (!report || !Array.isArray(report.suites)) return summary;

  const visitSuite = (suite, parents = []) => {
    const nextParents = suite.title ? [...parents, suite.title] : [...parents];

    for (const spec of suite.specs || []) {
      const titlePath = [...nextParents, spec.title].filter(Boolean).join(' > ');

      for (const test of spec.tests || []) {
        summary.total += 1;
        const outcome = test.outcome || 'unknown';

        if (outcome === 'expected') {
          summary.passed += 1;
        } else if (outcome === 'flaky') {
          summary.flaky += 1;
        } else if (outcome === 'skipped') {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
          const failingResult =
            (test.results || []).find((result) => result.status === 'failed') ||
            (test.results || []).find((result) => result.error) ||
            test.results?.[test.results.length - 1] ||
            null;
          summary.failures.push({
            title: titlePath,
            message: failingResult?.error?.message || failingResult?.error || `Unexpected outcome: ${outcome}`,
          });
        }
      }
    }

    for (const child of suite.suites || []) {
      visitSuite(child, nextParents);
    }
  };

  for (const suite of report.suites) {
    visitSuite(suite, []);
  }

  return summary;
}

function extractNetworkHints(specRelativePath) {
  const fullPath = path.join(repoRoot, specRelativePath);
  if (!fs.existsSync(fullPath)) return [];

  const text = fs.readFileSync(fullPath, 'utf-8');
  const endpointRegex = /\/api\/v1\/[A-Za-z0-9_\-./{}]+/g;
  const hints = new Set();
  let match;

  while ((match = endpointRegex.exec(text)) !== null) {
    hints.add(match[0]);
  }

  return [...hints].sort((a, b) => a.localeCompare(b));
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
    throw new Error('Failed to generate feature catalog before coverage run.');
  }
}

function ensureRealLlmEnvironment() {
  process.env.E2E_REAL_LLM = 'true';

  const provider = String(process.env.E2E_LLM_PROVIDER || 'moonshot').toLowerCase();
  const moonshotKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;

  if (provider === 'deepseek') {
    if (!deepseekKey) {
      throw new Error('E2E real mode requires DEEPSEEK_API_KEY (or OPENAI_API_KEY fallback) when provider=deepseek.');
    }
    if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = deepseekKey;
    if (!process.env.DEEPSEEK_BASE_URL) process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    if (!process.env.DEFAULT_MODEL) process.env.DEFAULT_MODEL = 'deepseek-chat';
    return { provider, model: process.env.DEFAULT_MODEL, base: process.env.DEEPSEEK_BASE_URL };
  }

  if (!moonshotKey) {
    throw new Error('E2E real mode requires MOONSHOT_API_KEY/KIMI_API_KEY (or OPENAI_API_KEY fallback) when provider=moonshot.');
  }

  if (!process.env.MOONSHOT_API_KEY) process.env.MOONSHOT_API_KEY = moonshotKey;
  if (!process.env.MOONSHOT_BASE_URL) process.env.MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
  if (!process.env.DEFAULT_MODEL) process.env.DEFAULT_MODEL = 'kimi-latest';

  return { provider, model: process.env.DEFAULT_MODEL, base: process.env.MOONSHOT_BASE_URL };
}

async function prepareServices(managedServices) {
  const backendHealthy = await waitForUrl(`${apiBase}/health`, 3000);
  if (!backendHealthy) {
    const backendPython = resolveBackendPythonCommand();
    if (!backendPython) {
      throw new Error('Backend not detected and no python runtime is available.');
    }
    console.log(`[coverage] backend not detected, starting \`${backendPython.display}\``);
    const backend = startService(backendPython.command, backendPython.runArgs, repoRoot, 'backend', process.env);
    managedServices.push({ child: backend, name: 'backend' });
  } else {
    console.log('[coverage] backend already running, reusing existing service.');
  }

  const frontendHealthy = await waitForUrl(frontendUrl, 3000);
  if (!frontendHealthy) {
    console.log('[coverage] frontend not detected, starting `npm run dev -- --host localhost --port 5174`.');
    const frontend = startService('npm', ['run', 'dev', '--', '--host', 'localhost', '--port', '5174'], repoRoot, 'frontend', process.env);
    managedServices.push({ child: frontend, name: 'frontend' });
  } else {
    console.log('[coverage] frontend already running, reusing existing service.');
  }

  const ready = await Promise.all([
    waitForUrl(`${apiBase}/health`, 90_000),
    waitForUrl(frontendUrl, 90_000),
  ]);

  if (!ready[0] || !ready[1]) {
    throw new Error('Services did not become healthy in time.');
  }
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

async function runTargetAttempt(target, runDir, attempt) {
  const attemptDir = path.join(runDir, `${target.id}-attempt-${attempt}`);
  const outputDir = path.join(attemptDir, 'test-results');
  const logPath = path.join(attemptDir, 'playwright.log');

  await fsp.mkdir(outputDir, { recursive: true });

  const args = ['playwright', 'test', target.spec, '--config=playwright.config.ts', '--reporter=json', '--output', outputDir];
  if (target.grep) {
    args.push('--grep', target.grep);
  }

  const execResult = await runCommandCapture('npx', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      E2E_REAL_LLM: 'true',
      E2E_BASE_URL: frontendUrl,
      E2E_API_BASE: apiBase,
      E2E_CAPTURE_PASS_SHOTS: process.env.E2E_CAPTURE_PASS_SHOTS || 'true',
    },
    echo: true,
  });

  await fsp.mkdir(attemptDir, { recursive: true });
  await fsp.writeFile(logPath, `${execResult.stdout}${execResult.stderr}`, 'utf-8');

  const parsed = parsePlaywrightJson(execResult.stdout);
  const summary = summarizePlaywrightReport(parsed);
  const pass = execResult.code === 0 && summary.failed === 0;

  return {
    attempt,
    pass,
    code: execResult.code,
    summary,
    log: toRel(logPath),
    artifact_dir: toRel(outputDir),
    network_hints: extractNetworkHints(target.spec),
    failure_category: classifyFailure(flattenArray(summary.failures.map((item) => item.message)).join('\n')),
  };
}

async function runExecutionTarget(target, runDir) {
  const first = await runTargetAttempt(target, runDir, 1);
  if (first.pass) {
    return {
      id: target.id,
      name: target.name,
      spec: target.spec,
      grep: target.grep,
      status: 'pass',
      attempts: [first],
      failure_messages: [],
      failure_category: null,
    };
  }

  const second = await runTargetAttempt(target, runDir, 2);
  const secondPassed = second.pass;
  const status = secondPassed ? 'flaky' : 'fail';
  const attempts = [first, second];
  const failureMessages = flattenArray(attempts.map((attempt) => attempt.summary.failures.map((item) => item.message)));

  return {
    id: target.id,
    name: target.name,
    spec: target.spec,
    grep: target.grep,
    status,
    attempts,
    failure_messages: failureMessages,
    failure_category: classifyFailure(failureMessages.join('\n')),
  };
}

function computeFeatureStatuses(features, paths, pathResultsById) {
  const featureStatus = [];

  for (const feature of features) {
    const ownedPaths = paths.filter((pathItem) => pathItem.feature_id === feature.feature_id);
    const statuses = ownedPaths.map((pathItem) => pathResultsById.get(pathItem.path_id)?.status || 'not_run');

    let status = 'pass';
    if (statuses.includes('fail')) status = 'fail';
    else if (statuses.includes('flaky')) status = 'flaky';
    else if (statuses.every((item) => item === 'not_run')) status = 'not_run';

    featureStatus.push({
      ...feature,
      status,
      path_ids: ownedPaths.map((item) => item.path_id),
      failed_paths: ownedPaths
        .filter((item) => (pathResultsById.get(item.path_id)?.status || 'not_run') === 'fail')
        .map((item) => item.path_id),
      flaky_paths: ownedPaths
        .filter((item) => (pathResultsById.get(item.path_id)?.status || 'not_run') === 'flaky')
        .map((item) => item.path_id),
    });
  }

  return featureStatus;
}

function loadPreviousMatrix() {
  if (!fs.existsSync(matrixPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(matrixPath, 'utf-8'));
  } catch {
    return null;
  }
}

function buildMarkdownReport(payload) {
  const lines = [];

  lines.push('# E2E Feature Coverage Report');
  lines.push('');
  lines.push(`- Run ID: ${payload.run.run_id}`);
  lines.push(`- Started: ${payload.run.started_at}`);
  lines.push(`- Ended: ${payload.run.ended_at}`);
  lines.push(`- LLM mode: ${payload.run.llm_mode}`);
  lines.push(`- Browser: ${payload.run.browser}`);
  lines.push(`- Result: ${payload.run.pass} PASS / ${payload.run.fail} FAIL / ${payload.run.flaky} FLAKY`);
  lines.push('');

  lines.push('## Coverage');
  lines.push('');
  lines.push(`- Features: ${payload.run.coverage.features_tested}/${payload.run.coverage.features_total}`);
  lines.push(`- Paths: ${payload.summary.paths_passed} pass / ${payload.summary.paths_failed} fail / ${payload.summary.paths_flaky} flaky`);
  lines.push('');

  lines.push('## Gate Decision');
  lines.push('');
  lines.push(`- Status: ${payload.gate.status}`);
  lines.push(`- Blocking failures: ${payload.gate.blocking_failures.length}`);
  lines.push(`- Warning failures: ${payload.gate.warning_failures.length}`);
  lines.push(`- Flaky blocking candidates: ${payload.gate.flaky_blocking_candidates.length}`);
  lines.push('');

  lines.push('## Failure Details');
  lines.push('');
  lines.push('| Path | Gate | Status | Target | Category | Evidence |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  const failedOrFlaky = payload.paths.filter((pathItem) => pathItem.status === 'fail' || pathItem.status === 'flaky');
  if (failedOrFlaky.length === 0) {
    lines.push('| - | - | - | - | - | - |');
  } else {
    for (const item of failedOrFlaky) {
      lines.push(
        `| ${item.path_id} | ${item.gate_level} | ${item.status} | ${item.execution_target} | ${item.failure_category || '-'} | ${item.evidence?.join('<br/>') || '-'} |`
      );
    }
  }

  lines.push('');
  lines.push('## Risk Assessment');
  lines.push('');
  if (payload.gate.status === 'not_run') {
    lines.push('- Execution was skipped; no runtime quality signal is available from this run.');
  } else if (payload.gate.blocking_failures.length > 0) {
    lines.push('- P0 blocker present: release/merge should be blocked until fixed.');
  } else if (payload.gate.warning_failures.length > 0) {
    lines.push('- No blocker failure. Warning paths failed and should be tracked in follow-up tasks.');
  } else {
    lines.push('- No blocking or warning failures in this run.');
  }

  if (payload.gate.flaky_blocking_candidates.length > 0) {
    lines.push(`- Repeated flaky detected (>=2): ${payload.gate.flaky_blocking_candidates.join(', ')}.`);
  }

  lines.push('');
  lines.push('## Fix Recommendations');
  lines.push('');
  lines.push('1. Prioritize fixes for blocking path failures first.');
  lines.push('2. For warning failures, add or update targeted specs and selectors to reduce false positives.');
  lines.push('3. For repeated flaky targets, stabilize async waits, data fixtures, and network dependencies.');
  lines.push('');

  lines.push('## Trend Comparison');
  lines.push('');
  if (!payload.trend.previous_run_id) {
    lines.push('- No previous feature-coverage run found for comparison.');
  } else {
    lines.push(`- Previous run: ${payload.trend.previous_run_id}`);
    lines.push(`- Delta pass: ${payload.trend.pass_delta >= 0 ? '+' : ''}${payload.trend.pass_delta}`);
    lines.push(`- Delta fail: ${payload.trend.fail_delta >= 0 ? '+' : ''}${payload.trend.fail_delta}`);
    lines.push(`- Delta flaky: ${payload.trend.flaky_delta >= 0 ? '+' : ''}${payload.trend.flaky_delta}`);
    lines.push(`- Delta coverage(features tested): ${payload.trend.coverage_delta >= 0 ? '+' : ''}${payload.trend.coverage_delta}`);
  }

  lines.push('');
  lines.push('## Evidence Index');
  lines.push('');
  for (const target of payload.targets) {
    const attemptEvidence = target.attempts.map((attempt) => `${attempt.artifact_dir} (log: ${attempt.log})`).join('<br/>');
    lines.push(`- ${target.id}: ${attemptEvidence}`);
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = new Date();
  const runId = timestampId();
  const runDir = path.join(artifactsRoot, runId, 'feature-coverage');
  const managedServices = [];

  await fsp.mkdir(runDir, { recursive: true });

  try {
    process.env.E2E_BASE_URL = frontendUrl;
    process.env.E2E_API_BASE = apiBase;

    await ensureCatalog();
    const llmMeta = dryRun
      ? { provider: 'dry-run', model: 'n/a', base: 'n/a' }
      : ensureRealLlmEnvironment();
    const previousMatrix = loadPreviousMatrix();

    const { features, testPaths, executionTargets } = await loadCatalogData();
    if (!features.length || !testPaths.length || !executionTargets.length) {
      throw new Error('Catalog data is incomplete (features/paths/targets missing).');
    }

    const targetById = new Map(executionTargets.map((target) => [target.id, target]));

    const blockingPathTargets = testPaths
      .filter((item) => item.gate_level === 'blocking')
      .map((item) => item.execution_target)
      .filter((id, index, arr) => arr.indexOf(id) === index);

    const warningPathTargets = testPaths
      .filter((item) => item.gate_level === 'warning')
      .map((item) => item.execution_target)
      .filter((id, index, arr) => arr.indexOf(id) === index);

    const orderedTargetIds = [...blockingPathTargets, ...warningPathTargets.filter((id) => !blockingPathTargets.includes(id))];

    const targetResults = [];
    if (dryRun) {
      console.log('[coverage] dry-run enabled, skipping Playwright execution.');
      for (const targetId of orderedTargetIds) {
        const target = targetById.get(targetId);
        if (!target) continue;
        targetResults.push({
          id: target.id,
          name: target.name,
          spec: target.spec,
          grep: target.grep,
          status: 'not_run',
          attempts: [],
          failure_messages: [],
          failure_category: null,
        });
      }
    } else {
      await prepareServices(managedServices);
      console.log(`[coverage] real-llm provider=${llmMeta.provider}, model=${llmMeta.model}, base=${llmMeta.base}`);

      for (const targetId of orderedTargetIds) {
        const target = targetById.get(targetId);
        if (!target) continue;

        console.log(`[coverage] running target=${target.id} (${target.spec})`);
        const result = await runExecutionTarget(target, runDir);
        targetResults.push(result);
      }
    }

    const previousFlakyByTarget = new Map();
    if (previousMatrix && Array.isArray(previousMatrix.targets)) {
      for (const target of previousMatrix.targets) {
        if (target?.id) {
          previousFlakyByTarget.set(String(target.id), Number(target.flaky_streak || 0));
        }
      }
    }

    const enhancedTargets = targetResults.map((target) => {
      const previousFlaky = previousFlakyByTarget.get(target.id) || 0;
      const flakyStreak = target.status === 'flaky' ? previousFlaky + 1 : 0;
      return {
        ...target,
        flaky_streak: flakyStreak,
      };
    });

    const targetResultById = new Map(enhancedTargets.map((item) => [item.id, item]));

    const pathResults = testPaths.map((pathItem) => {
      const target = targetResultById.get(pathItem.execution_target);
      const status = target?.status || 'not_run';

      const evidence = (target?.attempts || [])
        .flatMap((attempt) => [attempt.artifact_dir, attempt.log])
        .filter(Boolean);

      return {
        ...pathItem,
        status,
        target_status: status,
        attempts: target?.attempts || [],
        failure_category: target?.failure_category || null,
        evidence,
      };
    });

    const pathResultsById = new Map(pathResults.map((item) => [item.path_id, item]));
    const featureStatuses = computeFeatureStatuses(features, testPaths, pathResultsById);

    const pathsPassed = pathResults.filter((item) => item.status === 'pass').length;
    const pathsFailed = pathResults.filter((item) => item.status === 'fail').length;
    const pathsFlaky = pathResults.filter((item) => item.status === 'flaky').length;

    const runResult = {
      run_id: runId,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      llm_mode: 'real',
      browser: 'chromium-desktop',
      pass: pathsPassed,
      fail: pathsFailed,
      flaky: pathsFlaky,
      coverage: {
        features_total: features.length,
        features_tested: featureStatuses.filter((item) => item.status !== 'not_run').length,
      },
    };

    const blockingFailures = pathResults
      .filter((item) => item.gate_level === 'blocking' && item.status === 'fail')
      .map((item) => item.path_id);

    const warningFailures = pathResults
      .filter((item) => item.gate_level === 'warning' && item.status === 'fail')
      .map((item) => item.path_id);

    const flakyBlockingCandidates = enhancedTargets
      .filter((item) => item.flaky_streak >= 2)
      .map((item) => item.id);

    const allNotRun = pathResults.every((item) => item.status === 'not_run');
    const gateStatus = allNotRun
      ? 'not_run'
      : blockingFailures.length > 0
        ? 'blocked'
        : warningFailures.length > 0 || flakyBlockingCandidates.length > 0
          ? 'warn'
          : 'pass';

    const trend = {
      previous_run_id: previousMatrix?.run?.run_id || null,
      pass_delta: runResult.pass - Number(previousMatrix?.run?.pass || 0),
      fail_delta: runResult.fail - Number(previousMatrix?.run?.fail || 0),
      flaky_delta: runResult.flaky - Number(previousMatrix?.run?.flaky || 0),
      coverage_delta:
        runResult.coverage.features_tested -
        Number(previousMatrix?.run?.coverage?.features_tested || 0),
    };

    const payload = {
      generated_at: new Date().toISOString(),
      run: runResult,
      gate: {
        status: gateStatus,
        blocking_failures: blockingFailures,
        warning_failures: warningFailures,
        flaky_blocking_candidates: flakyBlockingCandidates,
      },
      summary: {
        paths_passed: pathsPassed,
        paths_failed: pathsFailed,
        paths_flaky: pathsFlaky,
      },
      trend,
      features: featureStatuses,
      paths: pathResults,
      targets: enhancedTargets,
      metadata: {
        dry_run: dryRun,
        llm_provider: dryRun ? 'dry-run' : process.env.E2E_LLM_PROVIDER || 'moonshot',
        frontend_url: frontendUrl,
        api_base: apiBase,
      },
    };

    await fsp.mkdir(path.dirname(matrixPath), { recursive: true });
    await fsp.writeFile(matrixPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

    const markdown = buildMarkdownReport(payload);
    await fsp.writeFile(reportPath, markdown, 'utf-8');

    console.log(`[coverage] report written: ${toRel(reportPath)}`);
    console.log(`[coverage] matrix written: ${toRel(matrixPath)}`);
    console.log(`[coverage] gate status: ${gateStatus}`);

    process.exitCode = gateStatus === 'blocked' ? 1 : 0;
  } finally {
    for (const service of managedServices.reverse()) {
      stopService(service.child, service.name);
    }
  }
}

await main();
