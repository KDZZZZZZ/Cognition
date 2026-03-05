import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectPendingDiffVisible } from './helpers/assertions';
import { installChatCapture } from './helpers/chatCapture';
import {
  bulkUpdatePermissionsApi,
  clickTab,
  createMarkdownFileApi,
  createSessionApi,
  openApp,
  openPdfToPage,
  openTreeItem,
  refreshExplorer,
  sendChatMessage,
  updateViewportApi,
  waitForPendingDiffApi,
  waitForTaskBoardVisible,
  uploadFileApi,
} from './helpers/sessionSetup';
import { loadTextbookManifest } from './helpers/tbFixture';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(12 * 60 * 1000);

test('tb_pending_diff_effective_note', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_pending_diff_effective_note');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const manifest = await loadTextbookManifest();
    const runId = Date.now();
    const marker = `PENDING_MARKER_${runId}`;
    const pdfName = `tb-pending-source-${runId}.pdf`;
    const noteName = `tb-pending-note-${runId}.md`;
    const sessionName = `tb-pending-session-${runId}`;

    const pdf = await uploadFileApi(request, {
      filePath: manifest.pdf_path,
      name: pdfName,
      mimeType: 'application/pdf',
    });
    const note = await createMarkdownFileApi(
      request,
      noteName,
      '# Existing Note\n\n- old point one\n- old point two\n'
    );
    const session = await createSessionApi(request, sessionName);
    await bulkUpdatePermissionsApi(request, session.id, {
      [pdf.id]: 'read',
      [note.id]: 'write',
    });

    await openApp(page);
    await refreshExplorer(page);
    await openTreeItem(page, note.name);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: note.id,
      page: 1,
      visibleUnit: 'line',
      visibleStart: 1,
      visibleEnd: 12,
    });
    await openPdfToPage(page, pdf.name, manifest.page_sets.long_scope.start_page);
    await openTreeItem(page, session.name);
    await clickTab(page, session.id);
    await waitForTaskBoardVisible(page);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: pdf.id,
      page: manifest.page_sets.long_scope.start_page,
      visibleUnit: 'page',
      visibleStart: manifest.page_sets.long_scope.start_page,
      visibleEnd: manifest.page_sets.long_scope.start_page,
    });

    const firstPrompt = `根据当前教材页给当前 note 追加两条要点，并把字符串 ${marker} 原样放进第二条。`;
    await sendChatMessage(page, firstPrompt);
    const firstExchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === firstPrompt,
      240_000
    );

    const firstPendingRaw = await waitForPendingDiffApi(request, note.id, 240_000);
    const firstPending = expectPendingDiffVisible(firstPendingRaw);
    await harness.verify('first_diff_contains_marker', () => {
      if (!String(firstPending.new_content || '').includes(marker)) {
        throw new Error(`First pending diff did not contain marker ${marker}.`);
      }
      return firstPending.id;
    }, (id) => `first pending diff=${id}`);

    await openTreeItem(page, note.name);
    await clickTab(page, note.id);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: note.id,
      page: 1,
      visibleUnit: 'line',
      visibleStart: 1,
      visibleEnd: 40,
      pendingDiffEventId: firstPending.id,
    });
    await harness.capture('pending-note-before-second-round');

    await openTreeItem(page, session.name);
    await clickTab(page, session.id);

    const secondPrompt = `根据我当前正在看的 note 最新内容，继续补一句，并复述第二条要点，保留标记 ${marker}。`;
    await sendChatMessage(page, secondPrompt);
    const secondExchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === secondPrompt,
      180_000
    );
    observedResponse = secondExchange.responseBody;

    await harness.verify('second_request_targets_note', () => {
      if (String(secondExchange.requestBody?.active_file_id || '') !== note.id) {
        throw new Error(`Expected second active_file_id=${note.id}, got ${secondExchange.requestBody?.active_file_id}`);
      }
      if (!secondExchange.requestBody?.active_visible_unit) {
        throw new Error('Expected second request to include active_visible_unit.');
      }
      return `${secondExchange.requestBody.active_file_id}:${secondExchange.requestBody.active_visible_unit}`;
    }, (detail) => `second request viewport=${detail}`);

    const secondPendingRaw = await waitForPendingDiffApi(request, note.id, 180_000);
    const secondPending = expectPendingDiffVisible(secondPendingRaw);
    await harness.verify('second_round_keeps_marker', () => {
      const content = `${String(secondExchange.responseBody?.data?.content || '')}\n${String(secondPending.new_content || '')}`;
      if (!content.includes(marker)) {
        throw new Error(`Second round did not preserve marker ${marker}.`);
      }
      return secondPending.id;
    }, (id) => `second pending diff=${id}`);

    await harness.verify('second_diff_extends_first_pending_content', () => {
      const firstContent = String(firstPending.new_content || '');
      const secondContent = String(secondPending.new_content || '');
      if (!secondContent.includes(marker)) {
        throw new Error('Second pending diff lost the marker.');
      }
      if (secondContent === firstContent) {
        throw new Error('Second pending diff did not evolve beyond the first pending diff.');
      }
      if (!secondContent.includes(firstContent.split('\n')[0] || '# Existing Note')) {
        throw new Error('Second pending diff does not appear to build from the first pending diff content.');
      }
      return secondContent.length;
    }, (length) => `second diff length=${length}`);

    harness.noteInfo(`First round active_file_id=${firstExchange.requestBody?.active_file_id || '(none)'}`);
    await harness.capture('pending-note-after-second-round');
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
