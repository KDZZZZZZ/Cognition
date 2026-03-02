#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../');
const reportPath = path.join(repoRoot, 'reports', 'e2e', 'full-flow-audit-report.md');
const latestTasksPath = path.join(repoRoot, 'reports', 'e2e', 'next-fix-tasks.md');

function timestampId() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function decodeCell(text) {
  return text.replaceAll('<br/>', '\n').replaceAll('\\|', '|').trim();
}

function parseRows(reportText) {
  const rows = [];
  for (const line of reportText.split('\n')) {
    if (!line.startsWith('| ') || line.includes('| --- |')) continue;
    const matched = line.match(/^\| (.+?) \| (PASS|FAIL|WARN) \| (.+?) \| (.+?) \|$/);
    if (!matched) continue;
    const [, step, status, details, evidence] = matched;
    rows.push({
      step: decodeCell(step),
      status,
      details: decodeCell(details),
      evidence: decodeCell(evidence),
    });
  }
  return rows;
}

function buildTaskMarkdown(items, runDirRel, logRel) {
  const now = new Date().toISOString();
  const failCount = items.filter((item) => item.status === 'FAIL').length;
  const warnCount = items.filter((item) => item.status === 'WARN').length;
  const lines = [];

  lines.push('# E2E Audit Next Fix Tasks');
  lines.push('');
  lines.push(`- Generated: ${now}`);
  lines.push(`- Run artifacts: ${runDirRel}`);
  lines.push(`- Run log: ${logRel}`);
  lines.push(`- Findings: ${failCount} FAIL / ${warnCount} WARN`);
  lines.push('');
  if (items.length === 0) {
    lines.push('- No FAIL/WARN findings in latest audit run.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Prioritized Checklist');
  lines.push('');
  for (const item of items) {
    const prefix = item.status === 'FAIL' ? '[P0]' : '[P1]';
    const evidencePart = item.evidence && item.evidence !== '-' ? ` | evidence: ${item.evidence}` : '';
    lines.push(`- [ ] ${prefix} ${item.step}`);
    lines.push(`  ${item.details}${evidencePart}`);
  }
  lines.push('');
  lines.push('## Rerun Command');
  lines.push('');
  lines.push('- `npm run e2e:audit:loop`');
  lines.push('');
  return lines.join('\n');
}

async function copyEvidence(rows, runDir) {
  const copied = [];
  for (const row of rows) {
    const evidence = row.evidence;
    if (!evidence || evidence === '-') continue;
    const source = path.join(repoRoot, evidence);
    if (!fs.existsSync(source)) continue;
    const target = path.join(runDir, evidence);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    copied.push(evidence);
  }
  return copied;
}

async function runAudit(logPath) {
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  return new Promise((resolve) => {
    const child = spawn('node', ['skills/knowledgeide-playwright-auditor/scripts/run-flow-audit.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        E2E_CAPTURE_PASS_SHOTS: process.env.E2E_CAPTURE_PASS_SHOTS || 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });

    child.on('exit', (code) => {
      logStream.end();
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      const msg = `[audit-loop] failed to start: ${err.message}\n`;
      process.stderr.write(msg);
      logStream.write(msg);
      logStream.end();
      resolve(1);
    });
  });
}

async function main() {
  const runId = timestampId();
  const runDir = path.join(repoRoot, 'reports', 'e2e', 'runs', runId);
  const runLogPath = path.join(runDir, 'audit.log');
  await fsp.mkdir(runDir, { recursive: true });

  const auditExitCode = await runAudit(runLogPath);

  if (!fs.existsSync(reportPath)) {
    console.error('[audit-loop] missing report file:', reportPath);
    process.exitCode = 1;
    return;
  }

  const reportText = await fsp.readFile(reportPath, 'utf-8');
  const rows = parseRows(reportText);
  const findingRows = rows.filter((row) => row.status === 'FAIL' || row.status === 'WARN');

  const runReportPath = path.join(runDir, 'full-flow-audit-report.md');
  await fsp.copyFile(reportPath, runReportPath);
  await copyEvidence(rows, runDir);

  const runDirRel = path.relative(repoRoot, runDir).replaceAll('\\', '/');
  const runLogRel = path.relative(repoRoot, runLogPath).replaceAll('\\', '/');
  const taskMarkdown = buildTaskMarkdown(findingRows, runDirRel, runLogRel);
  await fsp.writeFile(path.join(runDir, 'next-fix-tasks.md'), `${taskMarkdown}\n`, 'utf-8');
  await fsp.writeFile(latestTasksPath, `${taskMarkdown}\n`, 'utf-8');

  const failCount = findingRows.filter((row) => row.status === 'FAIL').length;
  const warnCount = findingRows.filter((row) => row.status === 'WARN').length;
  console.log(`[audit-loop] run saved: ${runDirRel}`);
  console.log(`[audit-loop] findings: ${failCount} FAIL / ${warnCount} WARN`);
  console.log(`[audit-loop] next tasks: ${path.relative(repoRoot, latestTasksPath).replaceAll('\\', '/')}`);

  process.exitCode = failCount > 0 ? 1 : auditExitCode;
}

await main();
