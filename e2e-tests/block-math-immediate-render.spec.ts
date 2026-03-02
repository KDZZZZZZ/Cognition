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

async function getParagraphTexts(page: any): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.ProseMirror > p')).map((p) => p.textContent || '')
  );
}

test('same-line $$x$$ should render immediately and continue typing on next line', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await createMarkdown(page, `block-math-inline-${Date.now()}.md`);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('$$x$$');
  await page.keyboard.type('NEXT');

  const lines = await getParagraphTexts(page);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines[1]).toContain('NEXT');
  expect(lines[0]).not.toContain('$$');
});

test('multiline $$ block should render at closing delimiter without refresh', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const formulaFileName = `block-math-multiline-${Date.now()}.md`;
  const switchFileName = `block-math-switch-${Date.now()}.md`;
  await createMarkdown(page, formulaFileName);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x+y');
  await page.keyboard.press('Enter');
  await page.keyboard.type('$$');
  await page.keyboard.type('NEXT');

  // wait for autosave debounce to verify no rollback occurs
  await page.waitForTimeout(800);

  let lines = await getParagraphTexts(page);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines[1]).toContain('NEXT');
  expect(lines.join('\n')).not.toContain('$$NEXT');

  await createMarkdown(page, switchFileName);

  const formulaTreeItem = page.locator('span.truncate', { hasText: formulaFileName }).first();
  await expect(formulaTreeItem).toBeVisible();
  await formulaTreeItem.click();

  await expect(editor).toBeVisible();
  lines = await getParagraphTexts(page);
  expect(lines.join('\n')).toContain('x+y');
  expect(lines.join('\n')).not.toContain('$$');
});
