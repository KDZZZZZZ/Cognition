import { expect, test } from '@playwright/test';

async function createItemFromRootMenu(page: any, itemName: 'New File' | 'New Session', value: string) {
  const addAtPath = page.locator('button[title="Add at current path"]').first();
  await expect(addAtPath).toBeVisible();
  await addAtPath.click();

  await page.getByRole('button', { name: itemName }).first().click();
  const input = page.locator('form input[type="text"]').last();
  await expect(input).toBeVisible();
  await input.fill(value);
  await page.getByRole('button', { name: 'Create' }).click();
}

test('editor selection context menu can import reference and open temp dialog', async ({ page }) => {
  await page.route('**/api/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const message = String(body.message || '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          message_id: `mock-${Date.now()}`,
          content: `mock-ok: ${message.slice(0, 40)}`,
          role: 'assistant',
          timestamp: new Date().toISOString(),
          tool_calls: [],
          tool_results: [],
        },
      }),
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const sessionName = `ctx-session-${Date.now()}`;
  const fileName = `ctx-note-${Date.now()}.md`;
  await createItemFromRootMenu(page, 'New Session', sessionName);
  await createItemFromRootMenu(page, 'New File', fileName);

  const sessionTreeItem = page.locator('span.truncate', { hasText: sessionName }).first();
  await expect(sessionTreeItem).toBeVisible();
  await sessionTreeItem.click();

  const mdTreeItem = page.locator('span.truncate', { hasText: fileName }).first();
  await expect(mdTreeItem).toBeVisible();
  await mdTreeItem.click();

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('hello **markdown** reference');
  await page.keyboard.press('Meta+a').catch(async () => page.keyboard.press('Control+a'));

  await editor.click({ button: 'right' });
  await expect(page.getByText('Import As Reference')).toBeVisible();
  await page.getByRole('button', { name: sessionName }).first().click();

  // Open context menu again and trigger temporary dialog.
  await editor.click({ button: 'right' });
  await page.getByRole('button', { name: 'Open Temporary Dialog (Fix / Check)' }).click();
  await expect(page.getByText('Temporary Document Dialog')).toBeVisible();
  await expect(page.getByText('hello **markdown** reference')).toBeVisible();

  await page.getByRole('button', { name: 'Check Selection' }).click();
  await expect(page.getByText(`Sent to session "${sessionName}"`)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Close' }).click();

  await sessionTreeItem.click();
  await expect(page.getByText('References')).toBeVisible();
  await expect(page.getByText('hello **markdown** reference').first()).toBeVisible();
});
