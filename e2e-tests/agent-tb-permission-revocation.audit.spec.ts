import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectPermissionRevoked, expectViewportInjected } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import {
  bulkUpdatePermissionsApi,
  clickTab,
  createSessionApi,
  openApp,
  openPdfToPage,
  openTreeItem,
  refreshExplorer,
  sendChatMessage,
  setPermissionByFileId,
  updateViewportApi,
  waitForTaskBoardVisible,
  uploadFileApi,
} from './helpers/sessionSetup';
import { loadTextbookManifest } from './helpers/tbFixture';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(8 * 60 * 1000);

test('tb_permission_revocation', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_permission_revocation');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const manifest = await loadTextbookManifest();
    const runId = Date.now();
    const pdfName = `tb-permission-source-${runId}.pdf`;
    const sessionName = `tb-permission-session-${runId}`;

    const pdf = await uploadFileApi(request, {
      filePath: manifest.pdf_path,
      name: pdfName,
      mimeType: 'application/pdf',
    });
    const session = await createSessionApi(request, sessionName);
    await bulkUpdatePermissionsApi(request, session.id, { [pdf.id]: 'read' });

    await openApp(page);
    await refreshExplorer(page);
    await openPdfToPage(page, pdf.name, manifest.page_sets.permission_probe.page);
    await openTreeItem(page, session.name);
    await clickTab(page, session.id);
    await waitForTaskBoardVisible(page);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: pdf.id,
      page: manifest.page_sets.permission_probe.page,
      visibleUnit: 'page',
      visibleStart: manifest.page_sets.permission_probe.page,
      visibleEnd: manifest.page_sets.permission_probe.page,
    });

    const firstPrompt = '概括当前教材页的两个关键点。';
    await sendChatMessage(page, firstPrompt);
    const firstExchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === firstPrompt
    );

    await harness.verify('first_request_has_pdf_viewport', () => {
      expectViewportInjected(firstExchange.requestBody, manifest.page_sets.permission_probe.page);
      return firstExchange.requestBody.active_file_id;
    }, (fileId) => `first request active_file_id=${fileId}`);

    await setPermissionByFileId(page, pdf.id, 'Hidden from AI');
    await harness.capture('permission-hidden');

    const secondPrompt = '继续引用刚才那本已经隐藏的教材里的结论。';
    await sendChatMessage(page, secondPrompt);
    const secondExchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === secondPrompt
    );
    observedResponse = secondExchange.responseBody;

    await harness.verify('permission_revoked_effective', () => {
      expectPermissionRevoked(secondExchange, pdf.name, pdf.id);
      return secondExchange.requestBody.context_files || [];
    }, (contextFiles) => `revoked context_files=[${contextFiles.join(', ')}]`);
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
