import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectNoEditorTools, expectStructuredPaperCollection, expectTaskPath, expectViewportInjected } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import { resolvePaperFixturePath } from './helpers/paperFixture';
import {
  clickTab,
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
  waitForTaskBoardVisible,
  waitForUploadProgressToSettle,
} from './helpers/sessionSetup';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60 * 1000);

test('paper_local_collection', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'Paper audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'paper_local_collection');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const paperPath = await resolvePaperFixturePath();
    const runId = Date.now();
    const pdfName = `paper-local-ui-${runId}.pdf`;
    const noteName = `paper-local-note-ui-${runId}.md`;
    const sessionName = `paper-local-session-ui-${runId}`;
    const targetPage = 1;

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
    await harness.capture('paper-local-before-send');

    const prompt = '请只基于当前论文做论文信息搜集，不联网，不要写当前 note。给我：1) 3-6 条 query 组；2) inclusion/exclusion；3) 必读/可选/综述/对照组候选与阅读顺序。任何当前论文没直接支持的内容标注待确认。';
    await sendChatMessage(page, prompt);

    const exchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt,
      240_000
    );
    observedResponse = exchange.responseBody;

    await harness.verify('task_path', () => expectTaskPath(exchange.responseBody, [
      'P_SEARCH_PLAN',
      'P_CANDIDATE_LIST',
    ]), (actual) => `task path: ${actual.join(' -> ')}`);

    await harness.verify('active_viewport_injected', () => {
      expectViewportInjected(exchange.requestBody, targetPage);
      return `${exchange.requestBody.active_file_id}@${exchange.requestBody.active_page}`;
    }, (detail) => `viewport=${detail}`);

    await harness.verify('no_editor_tools', () => expectNoEditorTools(exchange.responseBody), (tools) => `tools=[${tools.join(', ')}]`);

    await harness.verify('structured_collection_output', () => expectStructuredPaperCollection(exchange.responseBody, {
      requireUnconfirmedMarker: true,
    }), (detail) => `query=${detail.hasQueryGroup}, filters=${detail.hasFilters}, candidates=${detail.hasCandidates}, reading=${detail.hasReadingOrder}, uncertain=${detail.hasUnconfirmedMarker}`);

    const pending = await getPendingDiffApi(request, note.id).catch(() => ({ event: null }));
    await harness.assert(!pending?.event, 'no_note_diff', 'no diff event created for local collection flow', 'Unexpected diff event appeared during local paper collection flow.');
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
