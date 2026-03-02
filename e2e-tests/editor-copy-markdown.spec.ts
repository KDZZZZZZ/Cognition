import { expect, test } from '@playwright/test';

async function createMarkdown(page: any, name: string) {
  const addAtPath = page.locator('button[title="Add at current path"]').first();
  await expect(addAtPath).toBeVisible();
  await addAtPath.click();

  await page.getByRole('button', { name: 'New File' }).first().click();
  const input = page.locator('form input[type="text"]').last();
  await expect(input).toBeVisible();
  await input.fill(name);
  await page.getByRole('button', { name: 'Create' }).click();

  const treeItem = page.locator('span.truncate', { hasText: name }).first();
  await expect(treeItem).toBeVisible();
  await treeItem.click();
}

test('copy should place markdown source instead of inline math html wrappers', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await createMarkdown(page, `copy-markdown-${Date.now()}.md`);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('aa $ii$ bb');
  await page.keyboard.press('Meta+a').catch(async () => page.keyboard.press('Control+a'));

  await page.evaluate(() => {
    (window as any).__copyCapture = null;
    document.addEventListener(
      'copy',
      (event) => {
        (window as any).__copyCapture = {
          plain: event.clipboardData?.getData('text/plain') || '',
          markdown: event.clipboardData?.getData('text/markdown') || '',
          html: event.clipboardData?.getData('text/html') || '',
        };
      },
      { once: true }
    );
  });

  await page.keyboard.press('Meta+c').catch(async () => page.keyboard.press('Control+c'));
  const copy = await page.evaluate(() => (window as any).__copyCapture);

  expect(copy).toBeTruthy();
  expect(copy.plain).toContain('aa $ii$ bb');
  expect(copy.markdown).toContain('aa $ii$ bb');
  expect(copy.markdown).not.toContain('<span');
  expect(copy.plain).not.toContain('<span');
  expect(copy.html).toBe('');
});

test('copy should preserve block math as markdown delimiters', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await createMarkdown(page, `copy-block-markdown-${Date.now()}.md`);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('$$x$$');
  await page.keyboard.type('tail');
  await page.keyboard.press('Meta+a').catch(async () => page.keyboard.press('Control+a'));

  await page.evaluate(() => {
    (window as any).__copyCapture = null;
    document.addEventListener(
      'copy',
      (event) => {
        (window as any).__copyCapture = {
          plain: event.clipboardData?.getData('text/plain') || '',
          markdown: event.clipboardData?.getData('text/markdown') || '',
          html: event.clipboardData?.getData('text/html') || '',
        };
      },
      { once: true }
    );
  });

  await page.keyboard.press('Meta+c').catch(async () => page.keyboard.press('Control+c'));
  const copy = await page.evaluate(() => (window as any).__copyCapture);

  expect(copy).toBeTruthy();
  expect(copy.markdown).toContain('$$');
  expect(copy.markdown).toContain('x');
  expect(copy.markdown).toContain('tail');
  expect(copy.markdown).not.toContain('<span');
  expect(copy.plain).not.toContain('<span');
  expect(copy.html).toBe('');
});
