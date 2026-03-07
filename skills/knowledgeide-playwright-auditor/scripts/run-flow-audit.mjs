#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const backendRoot = path.join(repoRoot, 'backend');

const frontendUrl = process.env.E2E_BASE_URL || 'http://localhost:5174';
const apiBase = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';
const useRealLlm = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';
const rawScenarios = String(process.env.E2E_AUDIT_SCENARIOS || '').trim();

const SCENARIO_SPEC_MAP = {
  full_flow: 'e2e-tests/full-flow-audit.spec.ts',
  paper_summary_note: 'e2e-tests/agent-paper-summary.audit.spec.ts',
  paper_local_collection: 'e2e-tests/agent-paper-local-collection.audit.spec.ts',
  tb_long_scope_notes: 'e2e-tests/agent-tb-long-scope.audit.spec.ts',
  tb_qa_validate: 'e2e-tests/agent-tb-qa-validate.audit.spec.ts',
  tb_pending_diff_effective_note: 'e2e-tests/agent-tb-pending-diff.audit.spec.ts',
  tb_pdf_viewport_focus: 'e2e-tests/agent-tb-pdf-viewport.audit.spec.ts',
  tb_permission_revocation: 'e2e-tests/agent-tb-permission-revocation.audit.spec.ts',
  tb_force_compact_continuity: 'e2e-tests/agent-tb-compact.audit.spec.ts',
};

function resolveBackendPythonCommand() {
  const localVenvPython = process.platform === 'win32'
    ? path.join(backendRoot, 'venv', 'Scripts', 'python.exe')
    : path.join(backendRoot, 'venv', 'bin', 'python');

  const candidates = [];
  if (fs.existsSync(localVenvPython)) {
    candidates.push({
      command: localVenvPython,
      probeArgs: ['--version'],
      runArgs: ['main.py'],
      cwd: backendRoot,
      display: `${localVenvPython} main.py`,
    });
  }

  if (process.platform === 'win32') {
    candidates.push(
      { command: 'python', probeArgs: ['--version'], runArgs: ['main.py'], cwd: backendRoot, display: 'python main.py' },
      { command: 'py', probeArgs: ['-3', '--version'], runArgs: ['-3', 'main.py'], cwd: backendRoot, display: 'py -3 main.py' }
    );
  } else {
    candidates.push(
      { command: 'python', probeArgs: ['--version'], runArgs: ['main.py'], cwd: backendRoot, display: 'python main.py' },
      { command: 'python3', probeArgs: ['--version'], runArgs: ['main.py'], cwd: backendRoot, display: 'python3 main.py' }
    );
  }

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, candidate.probeArgs, {
      cwd: candidate.cwd || repoRoot,
      shell: false,
      stdio: 'ignore',
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function runCommand(command, args, cwd, name) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code) => resolveExit(code ?? 1));
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
  child.on('error', (error) => console.error(`[${name}] startup error:`, error.message));
  return child;
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

function stopService(child, name) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  console.log(`[${name}] stopped.`);
}

function resolveScenarioSpecs() {
  const defaultScenarios = ['full_flow'];
  const scenarioIds = rawScenarios
    ? rawScenarios.split(',').map((item) => item.trim()).filter(Boolean)
    : defaultScenarios;
  const unknown = scenarioIds.filter((item) => !SCENARIO_SPEC_MAP[item]);
  if (unknown.length) {
    throw new Error(`Unknown E2E_AUDIT_SCENARIOS: ${unknown.join(', ')}`);
  }
  const specs = [...new Set(scenarioIds.map((item) => SCENARIO_SPEC_MAP[item]))];
  return { scenarioIds, specs };
}

function ensureRealLlmProvider() {
  if (!useRealLlm) {
    console.log('[audit] mock-llm mode enabled (deterministic regression mode).');
    return;
  }

  const provider = String(process.env.E2E_LLM_PROVIDER || 'moonshot').toLowerCase();
  const moonshotKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;

  if (provider === 'deepseek' && !deepseekKey) {
    throw new Error('E2E_REAL_LLM=true with provider=deepseek requires DEEPSEEK_API_KEY (or OPENAI_API_KEY fallback).');
  }
  if (provider !== 'deepseek' && !moonshotKey) {
    throw new Error('E2E_REAL_LLM=true with provider=moonshot requires MOONSHOT_API_KEY/KIMI_API_KEY (or OPENAI_API_KEY fallback).');
  }

  if (provider === 'deepseek') {
    if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = deepseekKey;
    if (!process.env.DEEPSEEK_BASE_URL) process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    if (!process.env.DEFAULT_MODEL) process.env.DEFAULT_MODEL = 'deepseek-chat';
    console.log(`[audit] real-llm mode enabled (provider=deepseek, base=${process.env.DEEPSEEK_BASE_URL}, model=${process.env.DEFAULT_MODEL})`);
    return;
  }

  if (!process.env.MOONSHOT_API_KEY) process.env.MOONSHOT_API_KEY = moonshotKey;
  if (!process.env.MOONSHOT_BASE_URL) process.env.MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
  if (!process.env.DEFAULT_MODEL) process.env.DEFAULT_MODEL = 'kimi-latest';
  console.log(`[audit] real-llm mode enabled (provider=moonshot, base=${process.env.MOONSHOT_BASE_URL}, model=${process.env.DEFAULT_MODEL})`);
}

function ensureTbFixtureEnvIfNeeded(scenarioIds) {
  const hasTb = scenarioIds.some((item) => item.startsWith('tb_'));
  const needsSuiteReport = scenarioIds.some((item) => item !== 'full_flow');

  let reportDir = null;
  if (needsSuiteReport) {
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const defaultReportDir = path.join(repoRoot, 'reports', 'e2e', 'runs', timestamp);
    reportDir = path.resolve(process.env.E2E_AUDIT_REPORT_DIR || defaultReportDir);
    process.env.E2E_AUDIT_REPORT_DIR = reportDir;
  }

  if (!hasTb) return { hasTb: false, reportDir };

  if (!process.env.E2E_TEXTBOOK_FIXTURE_PATH) {
    process.env.E2E_TEXTBOOK_FIXTURE_PATH = path.join(repoRoot, 'e2e-tests', 'local-fixtures', 'textbooks', 'probability-tutorial.pdf');
  }
  if (!process.env.E2E_TEXTBOOK_MANIFEST_PATH) {
    process.env.E2E_TEXTBOOK_MANIFEST_PATH = path.join(repoRoot, 'e2e-tests', 'fixtures', 'textbooks', 'probability-tutorial.manifest.json');
  }
  return { hasTb: true, reportDir };
}

function prepareTbFixture() {
  console.log('[audit] preparing textbook fixture...');
  const code = spawnSync('node', ['e2e-tests/scripts/prepare-textbook-fixture.mjs'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  }).status;
  if (code !== 0) {
    throw new Error(`prepare-textbook-fixture.mjs failed with exit code ${code}`);
  }
}

function generateSuiteIndex(reportDir) {
  if (!reportDir || !fs.existsSync(reportDir)) return;
  const files = fs.readdirSync(reportDir)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .sort();
  const reports = files.map((name) => {
    const payload = JSON.parse(fs.readFileSync(path.join(reportDir, name), 'utf-8'));
    return payload;
  });
  const lines = [];
  lines.push('# E2E Audit Suite');
  lines.push('');
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- scenarios: ${reports.length}`);
  lines.push('');
  lines.push('| scenario_id | status | started_at | ended_at | hard_failures | warnings | report |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const report of reports) {
    const hardFailures = (report.hard_assertions || []).filter((item) => !item.passed).length;
    const warnings = (report.soft_observations || []).filter((item) => item.level === 'WARN').length;
    lines.push(`| ${report.scenario_id} | ${report.status} | ${report.started_at} | ${report.ended_at} | ${hardFailures} | ${warnings} | ${report.scenario_id}.md |`);
  }
  fs.writeFileSync(path.join(reportDir, 'index.md'), `${lines.join('\n')}\n`, 'utf-8');
}

async function main() {
  const managed = [];
  try {
    process.env.E2E_BASE_URL = frontendUrl;
    process.env.E2E_API_BASE = apiBase;
    process.env.E2E_REAL_LLM = useRealLlm ? 'true' : 'false';
    process.env.RELOAD = 'false';

    ensureRealLlmProvider();
    const { scenarioIds, specs } = resolveScenarioSpecs();
    const { hasTb, reportDir } = ensureTbFixtureEnvIfNeeded(scenarioIds);

    console.log(`[audit] repo root: ${repoRoot}`);
    console.log(`[audit] scenarios: ${scenarioIds.join(', ')}`);
    console.log(`[audit] specs: ${specs.join(', ')}`);
    if (reportDir) {
      console.log(`[audit] report dir: ${reportDir}`);
      fs.mkdirSync(reportDir, { recursive: true });
    }

    if (hasTb) {
      prepareTbFixture();
    }

    const backendHealthy = await waitForUrl(`${apiBase}/health`, 3000);
    if (!backendHealthy) {
      const backendPython = resolveBackendPythonCommand();
      if (!backendPython) {
        throw new Error('backend not detected and no Python runtime found (`python`/`python3`/`py -3`).');
      }
      console.log(`[audit] backend not detected, starting \`${backendPython.display}\``);
      const backend = startService(backendPython.command, backendPython.runArgs, backendPython.cwd || repoRoot, 'backend');
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
      throw new Error('services did not become healthy in time.');
    }

    const healthRes = await fetch(`${apiBase}/health`).catch(() => null);
    if (!healthRes || !healthRes.ok) {
      throw new Error('backend /health check failed before e2e run.');
    }

    const args = ['playwright', 'test', ...specs, '--config=playwright.config.ts', '--workers=1'];
    console.log(`[audit] services are healthy, running Playwright: npx ${args.join(' ')}`);
    const code = await runCommand('npx', args, repoRoot, 'playwright');
    if (reportDir) {
      generateSuiteIndex(reportDir);
    }
    process.exitCode = code;
  } catch (error) {
    console.error(`[audit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    for (const service of managed.reverse()) stopService(service.child, service.name);
  }
}

await main();
