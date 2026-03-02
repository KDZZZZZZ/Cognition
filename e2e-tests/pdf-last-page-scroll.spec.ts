import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('paging to last PDF page should not trigger outer-page downward jump', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const fileName = `pdf-last-page-scroll-${Date.now()}.pdf`;
  const samplePdf = await fs.readFile(path.resolve(process.cwd(), 'test_sample.pdf'));

  const uploadInput = page.locator('input[type="file"][accept=".md,.txt,.pdf"]').first();
  await uploadInput.setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: samplePdf,
  });

  const pdfTreeItem = page.locator('span.truncate', { hasText: fileName }).first();
  await expect(pdfTreeItem).toBeVisible({ timeout: 20_000 });
  await pdfTreeItem.click();

  const nextButton = page.locator('button[title="Next page"]').first();
  await expect(nextButton).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="pdf-scroll-container"]')).toBeVisible();

  // Wait until PDF pages are mounted.
  await expect(page.locator('.react-pdf__Page[data-page-number="1"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.react-pdf__Page[data-page-number="2"]').first()).toBeVisible({ timeout: 20_000 });

  const initialWindowScroll = await page.evaluate(() => window.scrollY);

  for (let i = 0; i < 12; i += 1) {
    if (await nextButton.isDisabled()) break;
    await nextButton.click();
    await page.waitForTimeout(220);
  }

  await expect(nextButton).toBeDisabled();
  const pageInput = page.locator('input[type="number"]').first();
  await expect(pageInput).toHaveValue('2');

  const metrics = await page.evaluate(() => {
    const container = document.querySelector('[data-testid="pdf-scroll-container"]') as HTMLElement | null;
    const toolbar = document.querySelector('[data-testid="pdf-toolbar"]') as HTMLElement | null;
    const maxScrollTop = container ? Math.max(container.scrollHeight - container.clientHeight, 0) : -1;
    return {
      windowScrollY: window.scrollY,
      toolbarTop: toolbar ? toolbar.getBoundingClientRect().top : -1,
      containerTop: container ? container.getBoundingClientRect().top : -1,
      scrollTop: container ? container.scrollTop : -1,
      maxScrollTop,
    };
  });

  expect(metrics.windowScrollY).toBe(initialWindowScroll);
  expect(metrics.toolbarTop).toBeGreaterThanOrEqual(0);
  expect(metrics.containerTop).toBeGreaterThanOrEqual(0);
  expect(metrics.scrollTop).toBeLessThanOrEqual(metrics.maxScrollTop + 1);
  expect(metrics.scrollTop).toBeGreaterThanOrEqual(0);
});
