import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectCompactTriggered } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import {
  clickTab,
  createSessionApi,
  openApp,
  openTreeItem,
  refreshExplorer,
  sendChatMessage,
  waitForTaskBoardVisible,
} from './helpers/sessionSetup';

const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'kimi-latest';
const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(14 * 60 * 1000);

test('tb_force_compact_continuity', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_force_compact_continuity');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;
  let compactResponse: any = null;

  try {
    const runId = Date.now();
    const sessionName = `tb-compact-session-${runId}`;

    const session = await createSessionApi(request, sessionName);

    const historyMessages = Array.from({ length: 3 }, (_, index) => {
      const loopNo = index + 1;
      return [
        `Round ${loopNo}.`,
        'General conversation load test only: not textbook, not paper, not note-writing.',
        'Open Loop 1: unresolved API timeout handling.',
        'Open Loop 2: unresolved cache invalidation rule.',
        'Open Loop 3: unresolved retry policy for transient failures.',
        'Open Loop 4: unresolved latency budget target.',
        'Repeat the following context to keep the session non-trivial:',
        'api timeout cache retry latency budget observability incident timeline '.repeat(140),
      ].join('\n');
    });

    for (const message of historyMessages) {
      const response = await request.post(`${API_BASE}/api/v1/chat/completions`, {
        data: {
          session_id: session.id,
          message,
          model: DEFAULT_MODEL,
          use_tools: false,
          compact_mode: 'auto',
        },
      });
      const json = await response.json();
      if (!response.ok() || !json?.success) {
        throw new Error(`Failed to seed compact history: ${JSON.stringify(json)}`);
      }
    }

    const forceResponse = await request.post(`${API_BASE}/api/v1/chat/completions`, {
      data: {
        session_id: session.id,
        message: '继续总结 Open Loop 1/2/3/4 的状态，重点说明第 3 项下一步。',
        model: DEFAULT_MODEL,
        use_tools: false,
        compact_mode: 'force',
      },
    });
    compactResponse = await forceResponse.json();
    if (!forceResponse.ok() || !compactResponse?.success) {
      throw new Error(`Force compact request failed: ${JSON.stringify(compactResponse)}`);
    }

    await harness.verify('compact_triggered', () => expectCompactTriggered(compactResponse), (meta) => {
      return `compaction_id=${meta.compaction_id}, before=${meta.before_tokens}, after=${meta.after_tokens}`;
    });

    await openApp(page);
    await refreshExplorer(page);
    await openTreeItem(page, session.name);
    await clickTab(page, session.id);
    await waitForTaskBoardVisible(page);
    await harness.capture('compact-session-before-followup');

    const prompt = '继续处理 Open Loop 3，并给出下一步动作。';
    await sendChatMessage(page, prompt);
    const exchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt,
      180_000
    );
    observedResponse = exchange.responseBody;

    await harness.verify('followup_not_failed', () => {
      if (exchange.responseBody?.data?.failed) {
        throw new Error('Follow-up after compact returned failed=true.');
      }
      return exchange.responseBody?.data?.task_registry?.status || 'ok';
    }, (status) => `task_registry.status=${status}`);

    await harness.verify('open_loop_3_continued', () => {
      const data = exchange.responseBody?.data || {};
      const content = String(data.content || '');
      const pauseQuestion = String(data.awaiting_user_input?.question || '');
      const toolResultText = JSON.stringify(data.tool_results || []);
      const signalRegex = /Open Loop 3|第\s*3|retry policy|API timeout|latency|transient failures/i;
      if (!signalRegex.test(content) && !signalRegex.test(pauseQuestion) && !signalRegex.test(toolResultText)) {
        throw new Error('Follow-up answer did not preserve any signal of Open Loop 3 continuity.');
      }
      return (content || pauseQuestion || toolResultText).slice(0, 160);
    }, (preview) => `follow-up preview=${preview}`);
  } catch (error) {
    unexpectedError = error;
  } finally {
    await harness.finalize({
      capturedChatRequests: capture.exchanges.map((item) => item.requestBody),
      capturedChatResponses: capture.exchanges.map((item) => item.responseBody),
      observedTaskRegistry: observedResponse?.data?.task_registry || null,
      observedBudgetMeta: observedResponse?.data?.budget_meta || compactResponse?.data?.budget_meta || null,
      observedCompactMeta: observedResponse?.data?.compact_meta || compactResponse?.data?.compact_meta || null,
      unexpectedError,
    });
  }

  if (unexpectedError) throw unexpectedError;
});
