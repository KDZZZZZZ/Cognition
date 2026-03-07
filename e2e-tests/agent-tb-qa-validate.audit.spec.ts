import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectNoEditorTools, expectTaskPath, expectViewportInjected } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import {
  clickTab,
  createItemViaQuickAction,
  findBackendFileByName,
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
  waitForFileIndexReady,
  waitForTaskBoardVisible,
} from './helpers/sessionSetup';
import { loadTextbookManifest } from './helpers/tbFixture';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(20 * 60 * 1000);

test('tb_qa_validate', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_qa_validate');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const manifest = await loadTextbookManifest();
    const runId = Date.now();
    const pdfName = process.env.E2E_TEXTBOOK_SHARED_PDF_NAME || 'tb-probability-shared-ui.pdf';
    const noteName = `tb-qa-note-ui-${runId}.md`;
    const sessionName = `tb-qa-session-ui-${runId}`;

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
    await openPdfToPage(page, pdf.name, manifest.page_sets.qa_validate.page);
    await openTreeItem(page, sessionName);
    await clickTab(page, sessionId);
    await waitForTaskBoardVisible(page);
    await setPermissionByFileId(page, pdf.id, 'Read permission');
    await setPermissionByFileId(page, note.id, 'Write permission');
    await updateViewportApi(request, {
      sessionId,
      fileId: pdf.id,
      page: manifest.page_sets.qa_validate.page,
      visibleUnit: 'page',
      visibleStart: manifest.page_sets.qa_validate.page,
      visibleEnd: manifest.page_sets.qa_validate.page,
    });
    await harness.capture('qa-session-before-send');

    const prompt = `只基于我当前打开的教材页和下面这段推导，检查哪里不合法，不要写笔记。我的推导：${manifest.page_sets.qa_validate.user_derivation_prompt}`;
    await sendChatMessage(page, prompt);
    const exchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt,
      240_000
    );
    observedResponse = exchange.responseBody;

    await harness.verify('task_first_step', () => {
      const actual = expectTaskPath(exchange.responseBody, ['TB_QA_VALIDATE']);
      if (actual[0] !== 'TB_QA_VALIDATE') {
        throw new Error(`Expected first step TB_QA_VALIDATE, got ${actual[0] || '(empty)'}`);
      }
      return actual;
    }, (actual) => `task path: ${actual.join(' -> ')}`);

    await harness.verify('active_page_injected', () => {
      expectViewportInjected(exchange.requestBody, manifest.page_sets.qa_validate.page);
      return `${exchange.requestBody.active_file_id}@${exchange.requestBody.active_page}`;
    }, (detail) => `viewport=${detail}`);

    await harness.verify('no_editor_tools', () => expectNoEditorTools(exchange.responseBody), (tools) => `tools=[${tools.join(', ')}]`);

    const citations = Array.isArray(exchange.responseBody?.data?.citations) ? exchange.responseBody.data.citations : [];
    if (citations.length > 0) {
      await harness.verify('citation_matches_qa_page', () => {
        const ok = citations.some((item: any) => Number(item?.page) === manifest.page_sets.qa_validate.page);
        if (!ok) throw new Error(`Expected citations to include page ${manifest.page_sets.qa_validate.page}.`);
        return citations.length;
      }, (count) => `citations=${count}`);
    } else {
      harness.noteWarn('QA validation response did not include citations.');
    }

    const pending = await getPendingDiffApi(request, note.id).catch(() => ({ event: null }));
    await harness.assert(!pending?.event, 'no_note_diff', 'no diff event created for QA flow', 'Unexpected diff event appeared during QA flow.');

    const content = String(exchange.responseBody?.data?.content || '');
    if (!/条件|前提|反例|错误|合法|independent|condition/i.test(content)) {
      harness.noteWarn('QA validation answer did not clearly expose condition checking language.');
    } else {
      harness.noteInfo('QA validation answer contains explicit condition-checking language.');
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
