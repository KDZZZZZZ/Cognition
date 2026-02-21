import { expect, test } from '@playwright/test';

test('newspaper theme baseline', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Explorer')).toBeVisible();

  const themeButton = page.locator('button[title="Light newspaper mode is fixed in this build"]').first();
  await expect(themeButton).toBeVisible();
  await expect(themeButton).toBeDisabled();

  const vars = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      bg: styles.getPropertyValue('--theme-bg').trim(),
      text: styles.getPropertyValue('--theme-text').trim(),
      border: styles.getPropertyValue('--theme-border').trim(),
      selectionBg: styles.getPropertyValue('--theme-selection-bg').trim(),
      selectionText: styles.getPropertyValue('--theme-selection-text').trim(),
    };
  });

  expect(vars.bg).toBe('#f4f3ee');
  expect(vars.text).toBe('#101010');
  expect(vars.border).toBe('#181818');
  expect(vars.selectionBg).toBe('#101010');
  expect(vars.selectionText).toBe('#f7f6f2');

  const sidebar = page.locator('div.w-64').first();
  await expect(sidebar).toBeVisible();
  const sidebarBorderStyle = await sidebar.evaluate((el) => getComputedStyle(el).borderRightStyle);
  expect(sidebarBorderStyle).toBe('dashed');

  const timelineHeader = page
    .getByText('Timeline', { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]');
  await expect(timelineHeader).toBeVisible();
  const timelineBorderStyle = await timelineHeader.evaluate((el) => getComputedStyle(el).borderBottomStyle);
  expect(timelineBorderStyle).toBe('dashed');

  const pane = page
    .locator('p:has-text("Empty Pane")')
    .first()
    .locator('xpath=ancestor::div[contains(@class,"min-w-[320px]")][1]');
  await expect(pane).toBeVisible();
  const paneBorderStyle = await pane.evaluate((el) => getComputedStyle(el).borderRightStyle);
  expect(paneBorderStyle).toBe('dashed');

  const hasWebkitScrollbarRule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }

      for (const rule of Array.from(rules)) {
        const selector = (rule as CSSStyleRule).selectorText || '';
        if (selector.includes('::-webkit-scrollbar')) {
          return true;
        }
      }
    }
    return false;
  });
  expect(hasWebkitScrollbarRule).toBeTruthy();

  const sessionName = `theme-session-${Date.now()}`;
  const newSessionButton = page.locator('button[title="New Session"]').first();
  await expect(newSessionButton).toBeVisible();
  await newSessionButton.click();

  const createDialogInput = page.locator('form input[type="text"]').last();
  await expect(createDialogInput).toBeVisible();
  await createDialogInput.fill(sessionName);
  await page.getByRole('button', { name: 'Create' }).click();

  const sessionTreeItem = page.locator('span.truncate', { hasText: sessionName }).first();
  await expect(sessionTreeItem).toBeVisible();
  await sessionTreeItem.click();

  const connectionBadge = page.locator('span:has-text("Connected"), span:has-text("Offline")').first();
  await expect(connectionBadge).toBeVisible({ timeout: 15000 });

  const connectionClass = (await connectionBadge.getAttribute('class')) || '';
  expect(connectionClass.includes('text-green-500') || connectionClass.includes('text-red-500')).toBeTruthy();
});
