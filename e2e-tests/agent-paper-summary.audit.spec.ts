import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectAnyToolName, expectPendingDiffVisible, expectTaskPath, expectViewportInjected, extractToolNames } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import { resolvePaperFixturePath } from './helpers/paperFixture';
import {
  clickTab,
  continueRecommendedPrompt,
  createItemViaQuickAction,
  getPendingDiffApi,
  openApp,
  openPdfToPage,
  openTreeItem,
  refreshExplorer,
  resolveSessionId,
  sendChatMessage,
  setPermissionByFileId,
  updateViewportApi,
  uploadFilesViaQuickAction,
  waitForBackendFileByName,
  waitForPageAssetsReady,
  waitForPendingDiffApi,
  waitForTaskBoardVisible,
  waitForUploadProgressToSettle,
} from './helpers/sessionSetup';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(12 * 60 * 1000);

test('paper_summary_note', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'Paper audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'paper_summary_note');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const paperPath = await resolvePaperFixturePath();
    const runId = Date.now();
    const pdfName = `paper-uploaded-ui-${runId}.pdf`;
    const noteName = `paper-note-ui-${runId}.md`;
    const sessionName = `paper-session-ui-${runId}`;
    const targetPage = 2;

    await openApp(page);
    await refreshExplorer(page);
    await uploadFilesViaQuickAction(page, [
      {
        filePath: paperPath,
        name: pdfName,
        mimeType: 'application/pdf',
      },
    ]);
    await waitForUploadProgressToSettle(page);
    await createItemViaQuickAction(page, 'New File', noteName);
    await createItemViaQuickAction(page, 'New Session', sessionName);

    const pdf = await waitForBackendFileByName(request, pdfName, 120_000);
    const note = await waitForBackendFileByName(request, noteName);
    const sessionId = await resolveSessionId(page, request, sessionName, 60_000);

    await openTreeItem(page, note.name);
    await openPdfToPage(page, pdf.name, targetPage);
    await openTreeItem(page, sessionName);
    await clickTab(page, sessionId);
    await waitForTaskBoardVisible(page);
    await setPermissionByFileId(page, pdf.id, 'Read permission');
    await setPermissionByFileId(page, note.id, 'Write permission');
    await updateViewportApi(request, {
      sessionId,
      fileId: pdf.id,
      page: targetPage,
      visibleUnit: 'page',
      visibleStart: targetPage,
      visibleEnd: targetPage,
    });
    await waitForPageAssetsReady(request, pdf.id, targetPage, 120_000);
    await harness.capture('paper-session-before-send');

    const prompt = '请基于我当前看的论文页面，用 1-6 模板总结这篇 paper，并把最重要的 figure/table 实际写入当前 note。只有生成待确认 diff 才算完成；回答里给出页码证据，不要编造结果。';
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
      const resumed = await continueRecommendedPrompt(page, 20_000);
      if (!resumed) break;
      const resumedExchange = await capture.waitForExchange(
        (item) => item.kind === 'answer' && String(item.requestBody?.session_id || '') === sessionId,
        240_000
      );
      finalResponseBody = resumedExchange.responseBody;
      observedResponse = finalResponseBody;
      await harness.noteInfo('Resumed paused paper summary task through UI.');
    }

    await harness.verify('resume_not_paused', () => {
      const paused = Boolean(finalResponseBody?.data?.paused);
      if (paused) {
        throw new Error('Paper task remains paused after UI resume attempts.');
      }
      return 'resumed_to_completion';
    }, (detail) => detail);

    await harness.verify('citation_or_reader_evidence', () => {
      const citations = Array.isArray(finalResponseBody?.data?.citations) ? finalResponseBody.data.citations : [];
      const tools = extractToolNames(finalResponseBody);
      const hasReaderTool = tools.some((tool) => ['read_document_segments', 'locate_relevant_segments', 'get_document_outline'].includes(tool));
      const hasPageCitation = citations.some((item: any) => Number(item?.page) === targetPage);
      if (!hasReaderTool && !hasPageCitation) {
        throw new Error(`Expected reader evidence or current-page citation. tools=[${tools.join(', ')}] citations=${citations.length}`);
      }
      return { hasReaderTool, hasPageCitation, toolCount: tools.length, citationCount: citations.length };
    }, (detail) => `reader_tool=${detail.hasReaderTool}, page_citation=${detail.hasPageCitation}, tools=${detail.toolCount}, citations=${detail.citationCount}`);

    await harness.verify('visual_tool_used', () => expectAnyToolName(finalResponseBody, [
      'inspect_document_visual',
      'add_file_charts_to_note',
    ]), (tool) => `visual_tool=${tool}`);

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
      capturedChatRequests: capture.exchanges.map((item) => item.requestBody),
      capturedChatResponses: capture.exchanges.map((item) => item.responseBody),
      observedTaskRegistry: observedResponse?.data?.task_registry || null,
      observedBudgetMeta: observedResponse?.data?.budget_meta || null,
      observedCompactMeta: observedResponse?.data?.compact_meta || null,
      unexpectedError,
    });
  }

  if (unexpectedError) throw unexpectedError;
});
