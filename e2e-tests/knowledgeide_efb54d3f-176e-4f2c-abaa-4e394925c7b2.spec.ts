
import { test } from '@playwright/test';
import { expect } from '@playwright/test';

test('KnowledgeIDE_2026-02-01', async ({ page, context }) => {
  
    // Navigate to URL
    await page.goto('http://localhost:5174');

    // Take screenshot
    await page.screenshot({ path: 'initial-state.png' });

    // Click element
    await page.click('button[title="New Folder (supports path: folder1/folder2)"]');

    // Take screenshot
    await page.screenshot({ path: 'new-folder-dialog.png' });

    // Fill input field
    await page.fill('input[type="text"]', 'Research');

    // Take screenshot
    await page.screenshot({ path: 'folder-created.png' });

    // Hover over element
    await page.hover('.group:has(span.truncate):has-text("Research")');

    // Take screenshot
    await page.screenshot({ path: 'hover-research.png' });

    // Click element
    await page.click('button[title="New File (supports path: folder/file.md)"]');

    // Fill input field
    await page.fill('input[type="text"]', 'Research/notes.md');

    // Take screenshot
    await page.screenshot({ path: 'file-created.png' });

    // Click element
    await page.click('button[title="New Session"]');

    // Fill input field
    await page.fill('input[type="text"]', 'TestSession');

    // Take screenshot
    await page.screenshot({ path: 'session-created.png' });

    // Click element
    await page.click('.group:has(span.truncate):has-text("notes.md")');

    // Take screenshot
    await page.screenshot({ path: 'notes-opened.png' });

    // Click element
    await page.click('button[title="Close tab"]');

    // Click element
    await page.click('[role='tab'] button svg');

    // Take screenshot
    await page.screenshot({ path: 'after-close.png' });

    // Take screenshot
    await page.screenshot({ path: 'drag-result.png' });

    // Click element
    await page.click('.ProseMirror');

    // Take screenshot
    await page.screenshot({ path: 'content-added.png' });

    // Take screenshot
    await page.screenshot({ path: 'full-view.png' });

    // Click element
    await page.click('.ProseMirror');

    // Take screenshot
    await page.screenshot({ path: 'after-typing.png' });

    // Click element
    await page.click('[role='tab']:has-text('TestSession')');

    // Take screenshot
    await page.screenshot({ path: 'before-session-click.png' });

    // Take screenshot
    await page.screenshot({ path: 'current-state.png' });

    // Take screenshot
    await page.screenshot({ path: 'scrolled-tree.png' });

    // Click element
    await page.click('button[title="New Session"]');

    // Fill input field
    await page.fill('input[type="text"]', 'AgentTest');

    // Take screenshot
    await page.screenshot({ path: 'session-created-2.png' });

    // Take screenshot
    await page.screenshot({ path: 'session-view.png' });

    // Take screenshot
    await page.screenshot({ path: 'session-full.png' });

    // Click element
    await page.click('input[placeholder*="Ask about your documents"], textarea[placeholder*="Ask"]');

    // Take screenshot
    await page.screenshot({ path: 'scrolled-to-bottom.png' });
});