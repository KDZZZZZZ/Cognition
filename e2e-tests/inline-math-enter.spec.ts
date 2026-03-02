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

test('inline math enter should create newline for uu$55$', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await createMarkdown(page, `inline-math-enter-${Date.now()}.md`);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('uu$55$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('NEXT');
  await page.waitForTimeout(700);

  const check = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { childCount: 0, secondLineText: '' };

    const childCount = pm.children.length;
    const secondLineText = childCount >= 2 ? (pm.children[1].textContent || '') : '';
    return { childCount, secondLineText };
  });

  expect(check.childCount).toBeGreaterThanOrEqual(2);
  expect(check.secondLineText).toContain('NEXT');
});

test('inline math followed by plain text should still enter newline for $ii$ii', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await createMarkdown(page, `inline-math-tail-text-${Date.now()}.md`);

  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toBeVisible();
  await editor.click();

  await page.keyboard.type('$ii$ii');
  await page.keyboard.press('Enter');
  await page.keyboard.type('NEXT');

  // Wait past autosave debounce to ensure line break is not rolled back
  // by an out-of-order parent content sync.
  await page.waitForTimeout(700);

  const check = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) return { childCount: 0, secondLineText: '' };

    const childCount = pm.children.length;
    const secondLineText = childCount >= 2 ? (pm.children[1].textContent || '') : '';
    return { childCount, secondLineText };
  });

  expect(check.childCount).toBeGreaterThanOrEqual(2);
  expect(check.secondLineText).toContain('NEXT');
});
