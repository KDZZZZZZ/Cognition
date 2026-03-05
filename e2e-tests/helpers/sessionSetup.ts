import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:8000';

export interface UploadedFileRef {
  id: string;
  name: string;
  type: string;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Explorer')).toBeVisible({ timeout: 30_000 });
}

export async function refreshExplorer(page: Page): Promise<void> {
  const button = page.locator('button[title="Refresh"]').first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await page.waitForTimeout(600);
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
  const permissionButton = permissionChip.locator('button[title]').first();
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
  const chatInput = page.locator('textarea[placeholder^="Type a message"]').first();
  await expect(chatInput).toBeVisible({ timeout: 20_000 });
  await chatInput.fill(message);
  await chatInput.press('Enter');
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
  const taskButton = page.getByRole('button', { name: /Task/i }).first();
  await expect(taskButton).toBeVisible({ timeout: 15_000 });
  await taskButton.click();
  await page.waitForTimeout(400);
}

export async function getTaskBoardText(page: Page): Promise<string> {
  await waitForTaskBoardVisible(page);
  return page.locator('text=No task registry yet').locator('xpath=ancestor::*[1]').textContent().catch(async () => {
    return page.locator('div.rounded-\[18px\]').allTextContents().then((items) => items.join('\n')).catch(() => '');
  });
}
