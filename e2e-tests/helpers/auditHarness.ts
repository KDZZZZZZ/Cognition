import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { deriveScenarioStatus, writeScenarioReport, type HardAssertionResult, type SoftObservation } from './reporting';

export class AuditHarness {
  readonly consoleIssues: string[] = [];
  readonly networkIssues: string[] = [];
  readonly artifacts: string[] = [];
  readonly hardAssertions: HardAssertionResult[] = [];
  readonly softObservations: SoftObservation[] = [];

  private readonly reportDir: string;
  private readonly artifactDir: string;
  private finalized = false;

  constructor(
    private readonly page: Page,
    private readonly testInfo: TestInfo,
    readonly scenarioId: string,
    readonly startedAt: string = new Date().toISOString()
  ) {
    this.reportDir = path.resolve(
      process.env.E2E_AUDIT_REPORT_DIR || path.join(process.cwd(), 'reports', 'e2e', 'runs', 'adhoc')
    );
    this.artifactDir = path.join(this.reportDir, 'artifacts', this.scenarioId);

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        this.consoleIssues.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      this.networkIssues.push(`REQUEST_FAILED ${req.method()} ${req.url()} (${failure?.errorText || 'unknown'})`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        this.networkIssues.push(`HTTP_${res.status()} ${res.request().method()} ${res.url()}`);
      }
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.artifactDir, { recursive: true });
  }

  recordPass(name: string, details: string, evidence?: string): void {
    this.hardAssertions.push({ name, passed: true, details, evidence });
  }

  recordFail(name: string, details: string, evidence?: string): void {
    this.hardAssertions.push({ name, passed: false, details, evidence });
  }

  noteWarn(text: string, evidence?: string): void {
    this.softObservations.push({ level: 'WARN', text, evidence });
  }

  noteInfo(text: string, evidence?: string): void {
    this.softObservations.push({ level: 'INFO', text, evidence });
  }

  async verify<T>(
    name: string,
    fn: () => Promise<T> | T,
    passDetails: string | ((result: T) => string)
  ): Promise<T> {
    try {
      const result = await fn();
      this.recordPass(name, typeof passDetails === 'function' ? passDetails(result) : passDetails);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const evidence = await this.capture(`fail-${name}`);
      this.recordFail(name, message, evidence);
      throw error;
    }
  }

  async capture(name: string, fullPage = true): Promise<string> {
    const filename = `${name.replace(/[^a-zA-Z0-9-_]+/g, '-')}.png`;
    const absolute = path.join(this.artifactDir, filename);
    try {
      await this.page.screenshot({ path: absolute, fullPage });
      const relative = path.relative(process.cwd(), absolute).replaceAll('\\', '/');
      this.artifacts.push(relative);
      return relative;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.noteWarn(`Failed to capture screenshot (${name}): ${message}`);
      return '';
    }
  }

  async assert(condition: boolean, name: string, passDetails: string, failDetails: string): Promise<void> {
    if (condition) {
      this.recordPass(name, passDetails);
      return;
    }
    const evidence = await this.capture(`fail-${name}`);
    this.recordFail(name, failDetails, evidence);
    throw new Error(failDetails);
  }

  async finalize(payload: {
    capturedChatRequests: any[];
    capturedChatResponses: any[];
    observedTaskRegistry?: any;
    observedBudgetMeta?: any;
    observedCompactMeta?: any;
    unexpectedError?: unknown;
  }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (payload.unexpectedError) {
      const message = payload.unexpectedError instanceof Error ? payload.unexpectedError.message : String(payload.unexpectedError);
      if (!this.hardAssertions.some((item) => !item.passed)) {
        const evidence = await this.capture('unexpected-error');
        this.recordFail('unexpected_error', message, evidence);
      }
    }

    const report = {
      scenario_id: this.scenarioId,
      started_at: this.startedAt,
      ended_at: new Date().toISOString(),
      status: deriveScenarioStatus(this.hardAssertions, this.softObservations),
      hard_assertions: this.hardAssertions,
      soft_observations: this.softObservations,
      captured_chat_requests: payload.capturedChatRequests,
      captured_chat_responses: payload.capturedChatResponses,
      observed_task_registry: payload.observedTaskRegistry || null,
      observed_budget_meta: payload.observedBudgetMeta || null,
      observed_compact_meta: payload.observedCompactMeta || null,
      artifacts: this.artifacts,
      console_issues: this.consoleIssues,
      network_issues: this.networkIssues,
    };

    await writeScenarioReport(this.reportDir, report);
    await this.testInfo.attach(`${this.scenarioId}-report`, {
      body: Buffer.from(JSON.stringify(report, null, 2), 'utf-8'),
      contentType: 'application/json',
    });
  }
}
