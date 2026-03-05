import { test } from '@playwright/test';
import { AuditHarness } from './helpers/auditHarness';
import { expectCitationToPage, expectViewportInjected, extractToolNames } from './helpers/assertions';
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
  updateViewportApi,
  waitForTaskBoardVisible,
  uploadFileApi,
} from './helpers/sessionSetup';
import { loadTextbookManifest } from './helpers/tbFixture';

const USE_REAL_LLM = String(process.env.E2E_REAL_LLM || '').toLowerCase() === 'true';

test.describe.configure({ mode: 'serial' });
test.setTimeout(8 * 60 * 1000);

test('tb_pdf_viewport_focus', async ({ page, request }, testInfo) => {
  test.skip(!USE_REAL_LLM, 'TB audit requires E2E_REAL_LLM=true');

  const harness = new AuditHarness(page, testInfo, 'tb_pdf_viewport_focus');
  await harness.init();
  const capture = installChatCapture(page);
  let unexpectedError: unknown;
  let observedResponse: any = null;

  try {
    const manifest = await loadTextbookManifest();
    const runId = Date.now();
    const pdfName = `tb-viewport-source-${runId}.pdf`;
    const sessionName = `tb-viewport-session-${runId}`;

    const pdf = await uploadFileApi(request, {
      filePath: manifest.pdf_path,
      name: pdfName,
      mimeType: 'application/pdf',
    });
    const session = await createSessionApi(request, sessionName);
    await bulkUpdatePermissionsApi(request, session.id, { [pdf.id]: 'read' });

    await openApp(page);
    await refreshExplorer(page);
    await openPdfToPage(page, pdf.name, manifest.page_sets.viewport_focus.page);
    await openTreeItem(page, session.name);
    await clickTab(page, session.id);
    await waitForTaskBoardVisible(page);
    await updateViewportApi(request, {
      sessionId: session.id,
      fileId: pdf.id,
      page: manifest.page_sets.viewport_focus.page,
      visibleUnit: 'page',
      visibleStart: manifest.page_sets.viewport_focus.page,
      visibleEnd: manifest.page_sets.viewport_focus.page,
    });
    await harness.capture('viewport-before-send');

    const prompt = '我现在这一页主要在讲什么？只回答当前页，不要总结整本书。回答里带当前页页码。';
    await sendChatMessage(page, prompt);
    const exchange = await capture.waitForExchange(
      (item) => item.kind === 'completion' && String(item.requestBody?.message || '') === prompt
    );
    observedResponse = exchange.responseBody;

    await harness.verify('active_page_injected', () => {
      expectViewportInjected(exchange.requestBody, manifest.page_sets.viewport_focus.page);
      return `${exchange.requestBody.active_file_id}@${exchange.requestBody.active_page}`;
    }, (detail) => `viewport=${detail}`);

    const citations = Array.isArray(exchange.responseBody?.data?.citations) ? exchange.responseBody.data.citations : [];
    if (citations.length > 0) {
      await harness.verify('citation_matches_current_page', () => {
        expectCitationToPage(exchange.responseBody, manifest.page_sets.viewport_focus.page);
        return citations.length;
      }, (count) => `citations=${count}`);
    } else {
      harness.noteWarn('Viewport focus response did not include citations.');
    }

    await harness.verify('reader_or_visual_tool_evidence', () => {
      const tools = extractToolNames(exchange.responseBody);
      const relevant = tools.filter((tool) => [
        'locate_relevant_segments',
        'read_document_segments',
        'get_document_outline',
        'inspect_document_visual',
      ].includes(tool));
      if (relevant.length === 0) {
        throw new Error(`Expected reader/visual tool evidence, got [${tools.join(', ')}]`);
      }
      return relevant;
    }, (tools) => `reader/visual tools=[${tools.join(', ')}]`);

    const content = String(exchange.responseBody?.data?.content || '');
    const forbidden = manifest.page_sets.viewport_focus.forbidden_neighbor_terms || [];
    if (forbidden.length > 0) {
      await harness.verify('no_neighbor_topic_drift', () => {
        const hit = forbidden.find((term) => term && content.toLowerCase().includes(String(term).toLowerCase()));
        if (hit) {
          throw new Error(`Response appears to drift into neighbor-page token: ${hit}`);
        }
        return forbidden;
      }, (terms) => `forbidden neighbor terms not observed: [${terms.join(', ')}]`);
    } else {
      harness.noteWarn('No forbidden_neighbor_terms found in textbook manifest for viewport drift check.');
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
