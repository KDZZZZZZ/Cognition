import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectPendingDiffVisible, expectTaskPath, expectViewportInjected, extractToolNames } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import { resolvePaperFixturePath } from './helpers/paperFixture';
import {
  bulkUpdatePermissionsApi,
  clickTab,
  createMarkdownFileApi,
  createSessionApi,
  getPendingDiffApi,
  openApp,
  openPdfToPage,
  openTreeItem,
  refreshExplorer,
  sendChatMessage,
  updateViewportApi,
  uploadFileApi,
  waitForPendingDiffApi,
  waitForTaskBoardVisible,
} from './helpers/sessionSetup';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';
const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60 * 1000);

test('paper_summary_note', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'Paper audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'paper_summary_note');
  await harness.init();
  const capture = installChatCapture(page);
  const extraCapturedRequests: any[] = [];
  const extraCapturedResponses: any[] = [];
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const paperPath = await resolvePaperFixturePath();
    const runId = Date.now();
    const pdfName = `paper-uploaded-${runId}.pdf`;
    const noteName = `paper-note-${runId}.md`;
    const sessionName = `paper-session-${runId}`;
    const targetPage = 2;

    const pdf = await uploadFileApi(request, {
      filePath: paperPath,
      name: pdfName,
      mimeType: 'application/pdf',
    });
    const note = await createMarkdownFileApi(request, noteName, '# Paper Summary\n\n');
    const session = await createSessionApi(request, sessionName);
    await bulkUpdatePermissionsApi(request, session.id, {
      [pdf.id]: 'read',
      [note.id]: 'write',
    });

    await openApp(page);
    await refreshExplorer(page);
    await openTreeItem(page, note.name);
    await openPdfToPage(page, pdf.name, targetPage);
    await openTreeItem(page, session.name);
    await clickTab(page, session.id);
    await waitForTaskBoardVisible(page);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: pdf.id,
      page: targetPage,
      visibleUnit: 'page',
      visibleStart: targetPage,
      visibleEnd: targetPage,
    });
    await harness.capture('paper-session-before-send');

    const prompt = '请基于我当前看的论文页面解释方法，并把结构化总结写入当前note。回答里给出页码证据，不要编造结果。';
    await sendChatMessage(page, prompt);

    const firstExchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt,
      360_000
    );
    let finalResponseBody = firstExchange.responseBody;
    observedResponse = finalResponseBody;

    await harness.verify('task_path', () => expectTaskPath(finalResponseBody, [
      'P_READ_SKELETON',
      'P_SUMMARY_CARD',
      'QUALITY_REVIEW',
      'CONTEXT_COMPACT',
    ]), (actual) => `task path: ${actual.join(' -> ')}`);

    await harness.verify('active_viewport_injected', () => {
      expectViewportInjected(firstExchange.requestBody, targetPage);
      return `${firstExchange.requestBody.active_file_id}@${firstExchange.requestBody.active_page}`;
    }, (detail) => `viewport=${detail}`);

    for (let i = 0; i < 3; i += 1) {
      const data = finalResponseBody?.data || {};
      if (!data?.paused) break;
      const pausePrompt = data.awaiting_user_input;
      const taskId = String(data.task_id || '').trim();
      const promptId = String(pausePrompt?.prompt_id || '').trim();
      const options = Array.isArray(pausePrompt?.options) ? pausePrompt.options : [];
      const selectedOptionId = String(
        pausePrompt?.recommended_option_id
        || options?.[0]?.id
        || ''
      ).trim();
      if (!taskId || !promptId || !selectedOptionId) {
        throw new Error('Paused response missing task_id/prompt_id/selected_option_id.');
      }

      await harness.noteInfo(`Auto-resume paused task using option=${selectedOptionId}`);
      const answerPayload = {
        session_id: session.id,
        prompt_id: promptId,
        selected_option_id: selectedOptionId,
      };
      extraCapturedRequests.push(answerPayload);
      const answerResponse = await request.post(
        `${API_BASE}/api/v1/chat/tasks/${encodeURIComponent(taskId)}/answer`,
        { data: answerPayload }
      );
      const answerJson = await answerResponse.json();
      if (!answerResponse.ok() || !answerJson?.success) {
        throw new Error(`Failed to resume paused paper task: status=${answerResponse.status()} body=${JSON.stringify(answerJson)}`);
      }
      extraCapturedResponses.push(answerJson);
      finalResponseBody = answerJson;
      observedResponse = finalResponseBody;
    }

    await harness.verify('resume_not_paused', () => {
      const paused = Boolean(finalResponseBody?.data?.paused);
      if (paused) {
        throw new Error('Paper task remains paused after auto-resume attempts.');
      }
      return 'resumed_to_completion';
    }, (detail) => detail);

    await harness.verify('citation_or_reader_evidence', () => {
      const citations = Array.isArray(finalResponseBody?.data?.citations) ? finalResponseBody.data.citations : [];
      const tools = extractToolNames(finalResponseBody);
      const hasReaderTool = tools.some((tool) => [
        'read_document_segments',
        'locate_relevant_segments',
        'search_pdf_passages',
        'read_document',
      ].includes(tool));
      const hasPageCitation = citations.some((item: any) => Number(item?.page) === targetPage);
      if (!hasReaderTool && !hasPageCitation) {
        throw new Error(`Expected reader evidence or current-page citation. tools=[${tools.join(', ')}] citations=${citations.length}`);
      }
      return { hasReaderTool, hasPageCitation, toolCount: tools.length, citationCount: citations.length };
    }, (detail) => `reader_tool=${detail.hasReaderTool}, page_citation=${detail.hasPageCitation}, tools=${detail.toolCount}, citations=${detail.citationCount}`);

    const toolResults = Array.isArray(finalResponseBody?.data?.tool_results) ? finalResponseBody.data.tool_results : [];
    const pendingFromToolResult = toolResults.find((item: any) => {
      if (String(item?.tool || '') !== 'update_file') return false;
      if (item?.result?.success !== true) return false;
      const status = String(item?.result?.data?.status || '').toLowerCase();
      return Boolean(item?.result?.data?.event_id) && (status === 'pending' || status === 'created');
    });

    await harness.verify('pending_diff_created', async () => {
      if (pendingFromToolResult?.result?.data?.event_id) {
        return { id: pendingFromToolResult.result.data.event_id, source: 'tool_result' };
      }
      const pending = await waitForPendingDiffApi(request, note.id, 60_000);
      return { id: expectPendingDiffVisible(pending)?.id, source: 'pending_api' };
    }, (pending) => `pending diff event=${pending.id}`);

    const pending = await getPendingDiffApi(request, note.id).catch(() => null);
    if (pending?.event?.id || pendingFromToolResult?.result?.data?.event_id) {
      await openTreeItem(page, note.name);
      await clickTab(page, note.id);
      await harness.capture('paper-note-diff-view');
    } else {
      harness.noteWarn('No pending diff found during paper note inspection, skipped diff panel capture.');
    }
  } catch (error) {
    unexpectedError = error;
  } finally {
    await harness.finalize({
      capturedChatRequests: [
        ...capture.exchanges.map((item) => item.requestBody),
        ...extraCapturedRequests,
      ],
      capturedChatResponses: [
        ...capture.exchanges.map((item) => item.responseBody),
        ...extraCapturedResponses,
      ],
      observedTaskRegistry: observedResponse?.data?.task_registry || null,
      observedBudgetMeta: observedResponse?.data?.budget_meta || null,
      observedCompactMeta: observedResponse?.data?.compact_meta || null,
      unexpectedError,
    });
  }

  if (unexpectedError) throw unexpectedError;
});
