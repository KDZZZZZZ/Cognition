import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectCitationToPage, expectPendingDiffVisible, expectTaskPath, expectViewportInjected } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import {
  clickTab,
  createItemViaQuickAction,
  findBackendFileByName,
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
  waitForFileIndexReady,
  waitForPendingDiffApi,
  waitForTaskBoardVisible,
} from './helpers/sessionSetup';
import { loadTextbookManifest } from './helpers/tbFixture';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(26 * 60 * 1000);

test('tb_long_scope_notes', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_long_scope_notes');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const manifest = await loadTextbookManifest();
    const runId = Date.now();
    const pdfName = process.env.E2E_TEXTBOOK_SHARED_PDF_NAME || 'tb-probability-shared-ui.pdf';
    const noteName = `tb-notes-ui-${runId}.md`;
    const sessionName = `tb-session-ui-${runId}`;

    await openApp(page);
    await refreshExplorer(page);
    let pdf = await findBackendFileByName(request, pdfName);
    if (!pdf) {
      await uploadFilesViaQuickAction(page, [
        {
          filePath: manifest.pdf_path,
          name: pdfName,
          mimeType: 'application/pdf',
        },
      ]);
      pdf = await waitForBackendFileByName(request, pdfName, 180_000);
    }
    await createItemViaQuickAction(page, 'New File', noteName);
    await createItemViaQuickAction(page, 'New Session', sessionName);

    const note = await waitForBackendFileByName(request, noteName);
    await waitForFileIndexReady(request, pdf.id, 18 * 60_000);
    const sessionId = await resolveSessionId(page, request, sessionName, 60_000);

    await openTreeItem(page, note.name);
    await openPdfToPage(page, pdf.name, manifest.page_sets.long_scope.start_page);
    await openTreeItem(page, sessionName);
    await clickTab(page, sessionId);
    await waitForTaskBoardVisible(page);
    await setPermissionByFileId(page, pdf.id, 'Read permission');
    await setPermissionByFileId(page, note.id, 'Write permission');
    await updateViewportApi(request, {
      sessionId,
      fileId: pdf.id,
      page: manifest.page_sets.long_scope.start_page,
      visibleUnit: 'page',
      visibleStart: manifest.page_sets.long_scope.start_page,
      visibleEnd: manifest.page_sets.long_scope.end_page,
    });
    await harness.capture('session-before-send');

    const prompt = `根据这本教材第 ${manifest.page_sets.long_scope.start_page}-${manifest.page_sets.long_scope.end_page} 页整理当前范围内容，写入当前 note。严格按教材章节小节模板组织：这一节要干什么、关键内容与推导、有什么用、相近知识。回答里保留页码证据。`;
    await sendChatMessage(page, prompt);

    const exchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt,
      360_000
    );
    observedResponse = exchange.responseBody;
    const toolResults = Array.isArray(exchange.responseBody?.data?.tool_results) ? exchange.responseBody.data.tool_results : [];
    const pendingFromToolResult = toolResults.find((item: any) => {
      if (String(item?.tool || '') !== 'update_file') return false;
      if (item?.result?.success !== true) return false;
      const status = String(item?.result?.data?.status || '').toLowerCase();
      return Boolean(item?.result?.data?.event_id) && (status === 'pending' || status === 'created');
    });

    await harness.verify('task_path', () => expectTaskPath(exchange.responseBody, [
      'TB_PARSE_SCOPE',
      'TB_EXTRACT_CORE',
      'TB_WRITE_NOTES',
      'TB_UPDATE_INDEX',
      'TB_UPDATE_NOTATION',
      'QUALITY_REVIEW',
      'CONTEXT_COMPACT',
    ]), (actual) => `task path: ${actual.join(' -> ')}`);

    await harness.verify('active_viewport_injected', () => {
      expectViewportInjected(exchange.requestBody, manifest.page_sets.long_scope.start_page);
      return exchange.requestBody.active_file_id;
    }, (activeFileId) => `active viewport file=${activeFileId}, page=${exchange.requestBody.active_page}`);

    await harness.verify('pending_diff_created', async () => {
      if (pendingFromToolResult?.result?.data?.event_id) {
        return { id: pendingFromToolResult.result.data.event_id, source: 'tool_result' };
      }
      const pending = await waitForPendingDiffApi(request, note.id, 60_000);
      return { id: expectPendingDiffVisible(pending)?.id, source: 'pending_api' };
    }, (pending) => `pending diff event=${pending.id}`);

    await harness.verify('citations_cover_scope', () => {
      const citations = Array.isArray(exchange.responseBody?.data?.citations) ? exchange.responseBody.data.citations : [];
      if (citations.length === 0) {
        throw new Error('Expected non-empty citations for TB long scope notes.');
      }
      const inRange = citations.some((item: any) => {
        const pageNo = Number(item?.page);
        return Number.isFinite(pageNo)
          && pageNo >= manifest.page_sets.long_scope.start_page
          && pageNo <= manifest.page_sets.long_scope.end_page;
      });
      if (!inRange) {
        throw new Error(`Expected at least one citation inside ${manifest.page_sets.long_scope.start_page}-${manifest.page_sets.long_scope.end_page}.`);
      }
      expectCitationToPage(exchange.responseBody, manifest.page_sets.long_scope.start_page);
      return citations.length;
    }, (count) => `citations=${count}`);

    const pending = await waitForPendingDiffApi(request, note.id, 15_000).catch(() => null);
    if (pending?.event?.id || pendingFromToolResult?.result?.data?.event_id) {
      await openTreeItem(page, note.name);
      await clickTab(page, note.id);
      await harness.capture('note-diff-view');
    } else {
      harness.noteWarn('No pending diff found during note inspection, skipped diff panel capture.');
    }

    const content = String(exchange.responseBody?.data?.content || '');
    const templateHits = ['这一节要干什么', '关键内容与推导', '有什么用', '相近知识'].filter((token) => content.includes(token));
    if (templateHits.length < 2) {
      harness.noteWarn(`Assistant content did not strongly expose textbook template anchors. hits=[${templateHits.join(', ')}]`);
    } else {
      harness.noteInfo(`Template anchors observed: ${templateHits.join(', ')}`);
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
