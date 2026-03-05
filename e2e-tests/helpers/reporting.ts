import fs from 'node:fs/promises';
import path from 'node:path';

export type ScenarioStatus = 'PASS' | 'FAIL' | 'WARN';

export interface HardAssertionResult {
  name: string;
  passed: boolean;
  details: string;
  evidence?: string;
}

export interface SoftObservation {
  level: 'INFO' | 'WARN';
  text: string;
  evidence?: string;
}

export interface ScenarioReport {
  scenario_id: string;
  started_at: string;
  ended_at: string;
  status: ScenarioStatus;
  hard_assertions: HardAssertionResult[];
  soft_observations: SoftObservation[];
  captured_chat_requests: any[];
  captured_chat_responses: any[];
  observed_task_registry: any;
  observed_budget_meta: any;
  observed_compact_meta: any;
  artifacts: string[];
  console_issues: string[];
  network_issues: string[];
}

function safeJson(value: unknown, maxLength = 8000): string {
  let text = '';
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...<truncated>` : text;
}

export function deriveScenarioStatus(
  hardAssertions: HardAssertionResult[],
  softObservations: SoftObservation[]
): ScenarioStatus {
  if (hardAssertions.some((item) => !item.passed)) return 'FAIL';
  if (softObservations.some((item) => item.level === 'WARN')) return 'WARN';
  return 'PASS';
}

export async function writeScenarioReport(reportDir: string, report: ScenarioReport): Promise<void> {
  await fs.mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, `${report.scenario_id}.json`);
  const mdPath = path.join(reportDir, `${report.scenario_id}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  const lines: string[] = [];
  lines.push(`# ${report.scenario_id}`);
  lines.push('');
  lines.push(`- started_at: ${report.started_at}`);
  lines.push(`- ended_at: ${report.ended_at}`);
  lines.push(`- status: ${report.status}`);
  lines.push('');
  lines.push('## hard_assertions');
  lines.push('');
  if (report.hard_assertions.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.hard_assertions) {
      lines.push(`- [${item.passed ? 'PASS' : 'FAIL'}] ${item.name}: ${item.details}`);
      if (item.evidence) lines.push(`  - evidence: ${item.evidence}`);
    }
  }
  lines.push('');
  lines.push('## soft_observations');
  lines.push('');
  if (report.soft_observations.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.soft_observations) {
      lines.push(`- [${item.level}] ${item.text}`);
      if (item.evidence) lines.push(`  - evidence: ${item.evidence}`);
    }
  }
  lines.push('');
  lines.push('## captured_chat_requests');
  lines.push('');
  lines.push('```json');
  lines.push(safeJson(report.captured_chat_requests));
  lines.push('```');
  lines.push('');
  lines.push('## captured_chat_responses');
  lines.push('');
  lines.push('```json');
  lines.push(safeJson(report.captured_chat_responses));
  lines.push('```');
  lines.push('');
  lines.push('## observed_task_registry');
  lines.push('');
  lines.push('```json');
  lines.push(safeJson(report.observed_task_registry));
  lines.push('```');
  lines.push('');
  lines.push('## observed_budget_meta');
  lines.push('');
  lines.push('```json');
  lines.push(safeJson(report.observed_budget_meta));
  lines.push('```');
  lines.push('');
  lines.push('## observed_compact_meta');
  lines.push('');
  lines.push('```json');
  lines.push(safeJson(report.observed_compact_meta));
  lines.push('```');
  lines.push('');
  lines.push('## artifacts');
  lines.push('');
  if (report.artifacts.length === 0) {
    lines.push('- none');
  } else {
    for (const artifact of report.artifacts) lines.push(`- ${artifact}`);
  }
  lines.push('');
  lines.push('## console_issues');
  lines.push('');
  if (report.console_issues.length === 0) {
    lines.push('- none');
  } else {
    for (const issue of report.console_issues) lines.push(`- ${issue}`);
  }
  lines.push('');
  lines.push('## network_issues');
  lines.push('');
  if (report.network_issues.length === 0) {
    lines.push('- none');
  } else {
    for (const issue of report.network_issues) lines.push(`- ${issue}`);
  }
  lines.push('');

  await fs.writeFile(mdPath, `${lines.join('\n')}\n`, 'utf-8');
}
