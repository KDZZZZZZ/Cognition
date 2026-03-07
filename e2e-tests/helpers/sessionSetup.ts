import fs from 'node:fs/promises';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';

export interface UploadedFileRef {
  id: string;
  name: string;
  type: string;
  created_at?: string;
  updated_at?: string;
}

type BackendFileRef = UploadedFileRef;

export interface BackendSessionRef {
  id: string;
  name: string;
  permissions?: Record<string, 'read' | 'write' | 'none'>;
  created_at?: string;
  updated_at?: string;
}

interface UploadInputItem {
  filePath?: string;
  name: string;
  mimeType: string;
  buffer?: Buffer;
}

const QUICK_ACTION_TEST_IDS = {
  'New File': 'quick-action-new-file',
  'New Session': 'quick-action-new-session',
  'New Folder': 'quick-action-new-folder',
  'Upload File': 'quick-action-upload-file',
} as const;

export async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Explorer')).toBeVisible({ timeout: 30_000 });
}

export async function refreshExplorer(page: Page): Promise<void> {
  const button = page.getByTestId('explorer-refresh').first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await page.waitForTimeout(600);
}

export async function waitForBackendFileByName(
  request: APIRequestContext,
  name: string,
  timeoutMs = 30_000
): Promise<BackendFileRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request.get(`${API_BASE}/api/v1/files/`);
    if (response.ok()) {
      const json = await response.json();
      const files = (json?.data?.files || []) as BackendFileRef[];
      const found = files
        .filter((file) => file.name === name)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Backend file not found: ${name}`);
}

export async function findBackendFileByName(
  request: APIRequestContext,
  name: string
): Promise<BackendFileRef | null> {
  const response = await request.get(`${API_BASE}/api/v1/files/`);
  if (!response.ok()) return null;
  const json = await response.json();
  const files = (json?.data?.files || []) as BackendFileRef[];
  return files
    .filter((file) => file.name === name)
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0] || null;
}

export async function waitForBackendSessionByName(
  request: APIRequestContext,
  name: string,
  timeoutMs = 30_000
): Promise<BackendSessionRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request.get(`${API_BASE}/api/v1/chat/sessions?limit=500`);
    if (response.ok()) {
      const json = await response.json();
      const sessions = (json?.data?.sessions || []) as BackendSessionRef[];
      const found = sessions
        .filter((session) => session.name === name)
        .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Backend session not found: ${name}`);
}

export async function openQuickActionMenu(page: Page): Promise<void> {
  const button = page.getByTestId('explorer-add-root').first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await expect(page.getByTestId('explorer-quick-action-menu')).toBeVisible({ timeout: 10_000 });
}

export async function clickQuickAction(
  page: Page,
  action: keyof typeof QUICK_ACTION_TEST_IDS
): Promise<void> {
  const button = page.getByTestId(QUICK_ACTION_TEST_IDS[action]).first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

export async function fillNewItemDialog(page: Page, value: string): Promise<void> {
  const dialog = page.getByTestId('new-item-dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  const input = page.getByTestId('new-item-dialog-input');
  await input.fill(value);
  await page.getByTestId('new-item-dialog-submit').click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

export async function createItemViaQuickAction(
  page: Page,
  action: 'New File' | 'New Session' | 'New Folder',
  value: string
): Promise<void> {
  await openQuickActionMenu(page);
  await clickQuickAction(page, action);
  await fillNewItemDialog(page, value);
}

export async function waitForUploadProgressToSettle(page: Page, timeoutMs = 360_000): Promise<void> {
  const progressCard = page.getByTestId('upload-progress-card');
  const becameVisible = await progressCard.isVisible().catch(() => false);

  if (!becameVisible) {
    await progressCard.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  }

  await progressCard.waitFor({ state: 'hidden', timeout: timeoutMs }).catch(async () => {
    const stillVisible = await progressCard.isVisible().catch(() => false);
    if (stillVisible) {
      throw new Error('Upload progress card did not settle before timeout.');
    }
  });
}

export async function uploadFilesViaQuickAction(page: Page, items: UploadInputItem[]): Promise<void> {
  await openQuickActionMenu(page);
  await clickQuickAction(page, 'Upload File');

  const uploadInput = page.getByTestId('explorer-upload-input');
  await uploadInput.setInputFiles(
    await Promise.all(
      items.map(async (item) => ({
        name: item.name,
        mimeType: item.mimeType,
        buffer: item.buffer ?? (await fs.readFile(item.filePath || '')),
      }))
    )
  );
}

export async function resolveSessionId(
  page: Page,
  request: APIRequestContext,
  sessionName: string,
  timeoutMs = 30_000
): Promise<string> {
  const backendSession = await waitForBackendSessionByName(request, sessionName, timeoutMs).catch(() => null);
  if (backendSession?.id) return backendSession.id;

  await openTreeItem(page, sessionName);
  const sessionTab = page.locator('div[draggable="true"]').filter({ hasText: sessionName }).first();
  await expect(sessionTab).toBeVisible({ timeout: 15_000 });
  const sessionTabId = await sessionTab.getAttribute('data-tab-id');
  if (sessionTabId) return sessionTabId;

  throw new Error(`Could not resolve session id from backend or UI tab: ${sessionName}`);
}

export async function createSessionApi(request: APIRequestContext, name: string, id?: string): Promise<{ id: string; name: string }> {
  const response = await request.post(`${API_BASE}/api/v1/chat/sessions`, {
    data: { id, name, permissions: {} },
  });
  const json = await response.json();
  if (!response.ok() || !json?.success) {
    throw new Error(`Failed to create session ${name}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function uploadFileApi(
  request: APIRequestContext,
  params: {
    filePath?: string;
    name: string;
    mimeType: string;
    buffer?: Buffer;
    parentId?: string | null;
  }
): Promise<UploadedFileRef> {
  const buffer = params.buffer ?? (await fs.readFile(params.filePath || ''));
  const maxAttempts = 4;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await request.post(`${API_BASE}/api/v1/files/upload`, {
      multipart: {
        file: {
          name: params.name,
          mimeType: params.mimeType,
          buffer,
        },
        ...(params.parentId ? { parent_id: params.parentId } : {}),
      },
    });

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }

    if (response.ok() && body?.success) {
      return {
        id: String(body.data.file_id),
        name: String(body.data.name),
        type: String(body.data.type),
      };
    }

    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    const retryable =
      response.status() >= 500 ||
      /database is locked|sqlite_busy|service unavailable/i.test(bodyText || '');

    lastError = new Error(`Failed to upload ${params.name}: ${bodyText}`);
    if (!retryable || attempt === maxAttempts) {
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 700));
  }

  throw lastError || new Error(`Failed to upload ${params.name}: unknown error`);
}

export async function createMarkdownFileApi(
  request: APIRequestContext,
  name: string,
  content = '',
  parentId?: string | null
): Promise<UploadedFileRef> {
  return uploadFileApi(request, {
    name,
    mimeType: 'text/markdown',
    buffer: Buffer.from(content, 'utf-8'),
    parentId,
  });
}

export async function bulkUpdatePermissionsApi(
  request: APIRequestContext,
  sessionId: string,
  permissions: Record<string, 'read' | 'write' | 'none'>
): Promise<void> {
  const response = await request.put(`${API_BASE}/api/v1/chat/sessions/${sessionId}/permissions`, {
    data: permissions,
  });
  const json = await response.json();
  if (!response.ok() || !json?.success) {
    throw new Error(`Failed to update permissions for ${sessionId}: ${JSON.stringify(json)}`);
  }
}

export async function waitForTreeItem(page: Page, name: string, timeoutMs = 30_000) {
  const item = page.locator('span.truncate', { hasText: name }).first();
  await expect(item).toBeVisible({ timeout: timeoutMs });
  return item;
}

export async function openTreeItem(page: Page, name: string): Promise<void> {
  const item = await waitForTreeItem(page, name);
  await item.click();
  await page.waitForTimeout(400);
}

export async function clickTab(page: Page, tabRef: string): Promise<void> {
  const byId = page.locator(`div[draggable="true"][data-tab-id="${tabRef}"]`).first();
  if (await byId.count()) {
    await byId.click();
    return;
  }
  const byName = page.locator('div[draggable="true"]').filter({ hasText: tabRef }).first();
  await expect(byName).toBeVisible({ timeout: 15_000 });
  await byName.click();
}

export async function setPermissionByFileId(page: Page, fileId: string, targetTitle: 'Read permission' | 'Write permission' | 'Hidden from AI'): Promise<void> {
  const permissionChip = page.locator(`[data-context-file-id="${fileId}"]`).first();
  const permissionButton = permissionChip.locator(`[data-context-permission-file-id="${fileId}"]`).first();
  await expect(permissionButton).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 6; i += 1) {
    const current = await permissionButton.getAttribute('title');
    if (current === targetTitle) return;
    await permissionButton.click();
    await page.waitForTimeout(350);
  }
  throw new Error(`Permission for ${fileId} did not reach ${targetTitle}.`);
}

export async function openPdfToPage(page: Page, pdfName: string, targetPage: number): Promise<void> {
  await openTreeItem(page, pdfName);
  const toolbar = page.getByTestId('pdf-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  const pageInput = toolbar.locator('input[type="number"]').first();
  await pageInput.fill(String(targetPage));
  await pageInput.press('Enter');
  await page.waitForTimeout(1200);
}

export async function sendChatMessage(page: Page, message: string): Promise<void> {
  const chatInput = page.getByTestId('session-message-input').first();
  await expect(chatInput).toBeVisible({ timeout: 20_000 });
  await chatInput.fill(message);
  await chatInput.press('Enter');
}

export async function continueRecommendedPrompt(page: Page, timeoutMs = 10_000): Promise<boolean> {
  const prompt = page.getByTestId('session-paused-prompt').first();
  const visible = await prompt.isVisible().catch(() => false);
  if (!visible) {
    await prompt.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {});
  }

  const finalVisible = await prompt.isVisible().catch(() => false);
  if (!finalVisible) return false;

  const button = prompt.getByTestId('session-continue-task');
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await prompt.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {});
  return true;
}

export async function getFileIndexStatusApi(
  request: APIRequestContext,
  fileId: string
): Promise<{
  file_id: string;
  parse_status: string;
  embedding_status: string;
  last_error?: string | null;
  updated_at?: string | null;
}> {
  const response = await request.get(`${API_BASE}/api/v1/files/${fileId}/index-status`);
  const json = await response.json();
  if (!response.ok() || !json?.success) {
    throw new Error(`Failed to fetch index status for ${fileId}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function waitForFileIndexReady(
  request: APIRequestContext,
  fileId: string,
  timeoutMs = 15 * 60_000
): Promise<{
  file_id: string;
  parse_status: string;
  embedding_status: string;
  last_error?: string | null;
  updated_at?: string | null;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: Awaited<ReturnType<typeof getFileIndexStatusApi>> | null = null;
  while (Date.now() < deadline) {
    lastStatus = await getFileIndexStatusApi(request, fileId);
    const parseReady = String(lastStatus.parse_status || '').toLowerCase() === 'ready';
    const embedReady = ['ready', 'ready_with_errors', 'disabled'].includes(
      String(lastStatus.embedding_status || '').toLowerCase()
    );
    if (parseReady && embedReady) return lastStatus;
    if (String(lastStatus.parse_status || '').toLowerCase() === 'failed' || String(lastStatus.embedding_status || '').toLowerCase() === 'failed') {
      throw new Error(
        `Index failed for ${fileId}: parse=${lastStatus.parse_status} embedding=${lastStatus.embedding_status} error=${lastStatus.last_error || ''}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Timed out waiting for index ready on ${fileId}: parse=${lastStatus?.parse_status || 'unknown'} embedding=${lastStatus?.embedding_status || 'unknown'}`
  );
}

export async function getPageAssetsApi(
  request: APIRequestContext,
  fileId: string,
  page?: number
): Promise<{
  file_id: string;
  count: number;
  assets: Array<{ id: string; page: number; image_url?: string | null; text_anchor?: string | null }>;
}> {
  const suffix = typeof page === 'number' ? `?page=${page}` : '';
  const response = await request.get(`${API_BASE}/api/v1/files/${fileId}/page-assets${suffix}`);
  const json = await response.json();
  if (!response.ok() || !json?.success) {
    throw new Error(`Failed to fetch page assets for ${fileId}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function waitForPageAssetsReady(
  request: APIRequestContext,
  fileId: string,
  page: number,
  timeoutMs = 120_000
): Promise<{
  file_id: string;
  count: number;
  assets: Array<{ id: string; page: number; image_url?: string | null; text_anchor?: string | null }>;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastData: Awaited<ReturnType<typeof getPageAssetsApi>> | null = null;
  while (Date.now() < deadline) {
    lastData = await getPageAssetsApi(request, fileId, page);
    const ready = (lastData.assets || []).some((asset) => Number(asset.page) === page && Boolean(asset.image_url));
    if (ready) return lastData;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for visual page assets on ${fileId} page ${page}. last_count=${lastData?.count || 0}`);
}

 
export async function updateViewportApi(
  request: APIRequestContext,
  payload: {
    sessionId: string;
    fileId: string;
    page: number;
    scrollY?: number;
    visibleUnit?: 'page' | 'line' | 'paragraph' | 'pixel';
    visibleStart?: number;
    visibleEnd?: number;
    pendingDiffEventId?: string;
  }
): Promise<void> {
  const response = await request.post(`${API_BASE}/api/v1/viewport/update`, {
    data: {
      session_id: payload.sessionId,
      file_id: payload.fileId,
      page: payload.page,
      scroll_y: payload.scrollY ?? 0,
      visible_range_start: payload.scrollY ?? 0,
      visible_range_end: (payload.scrollY ?? 0) + 900,
      visible_unit: payload.visibleUnit,
      visible_start: payload.visibleStart,
      visible_end: payload.visibleEnd,
      pending_diff_event_id: payload.pendingDiffEventId,
    },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    try {
      body = await response.text();
    } catch {
      body = null;
    }
  }
  if (!response.ok() || !body?.success) {
    throw new Error(`Failed to update viewport for ${payload.fileId}: status=${response.status()} body=${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export async function getPendingDiffApi(request: APIRequestContext, fileId: string): Promise<any> {
  const response = await request.get(`${API_BASE}/api/v1/files/${fileId}/diff-events/pending`);
  const json = await response.json();
  if (!response.ok() || !json?.success) {
    throw new Error(`Failed to fetch pending diff for ${fileId}: ${JSON.stringify(json)}`);
  }
  return json.data;
}

export async function waitForPendingDiffApi(request: APIRequestContext, fileId: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await getPendingDiffApi(request, fileId);
    if (data?.event?.id) return data;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error(`Timed out waiting for pending diff on file ${fileId}`);
}

export async function waitForTaskBoardVisible(page: Page): Promise<void> {
  const taskButton = page.getByTestId('session-task-board-toggle').first();
  await expect(taskButton).toBeVisible({ timeout: 15_000 });
  const expanded = await taskButton.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await taskButton.click();
    await page.waitForTimeout(400);
  }
}

export async function getTaskBoardText(page: Page): Promise<string> {
  await waitForTaskBoardVisible(page);
  return page.locator('text=No task registry yet').locator('xpath=ancestor::*[1]').textContent().catch(async () => {
    return page.locator('div[class*="rounded-[18px]"]').allTextContents().then((items) => items.join('\n')).catch(() => '');
  });
}
