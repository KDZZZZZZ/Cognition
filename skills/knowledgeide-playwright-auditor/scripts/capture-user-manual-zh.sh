#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"
SESSION="manual-zh"
OUT_DIR="$REPO_ROOT/output/playwright/user-manual-zh"
mkdir -p "$OUT_DIR"

MANUAL_FOLDER="manual-folder"
MANUAL_NOTE="manual-note.md"
MANUAL_REF="manual-ref.md"
MANUAL_SESSION="manual-session"
MANUAL_PDF="manual-sample.pdf"

run_code() {
  local code
  code="$(cat)"
  "$PWCLI" --session "$SESSION" run-code "$code"
}

page_shot() {
  local file="$1"
  run_code <<EOF2
async (page) => {
  await page.screenshot({ path: 'output/playwright/user-manual-zh/${file}', fullPage: false });
}
EOF2
}

node_fetch() {
  node --input-type=module - "$@"
}

"$PWCLI" close-all >/dev/null 2>&1 || true
"$PWCLI" --session "$SESSION" open "${E2E_BASE_URL:-http://localhost:5174}" >/dev/null
"$PWCLI" --session "$SESSION" resize 1600 1100 >/dev/null

run_code <<'EOF2'
async (page) => {
  await page.route('**/api/v1/chat/completions', async (route) => {
    const body = route.request().postDataJSON() || {};
    const message = String(body.message || '');
    const isSelectionAction = message.includes('选中内容') || message.includes('检查') || message.includes('修正');

    const payload = isSelectionAction
      ? {
          success: true,
          data: {
            message_id: `mock-${Date.now()}`,
            content: '这是演示用回复：系统已经接收选中内容，并把建议返回到会话区。',
            role: 'assistant',
            timestamp: new Date().toISOString(),
            tool_calls: [],
            tool_results: [],
          },
        }
      : {
          success: true,
          data: {
            message_id: `mock-${Date.now()}`,
            content: '这是演示用回复：我已经读取可见文档，并给出下一步处理建议。',
            role: 'assistant',
            timestamp: new Date().toISOString(),
            tool_calls: [
              {
                id: 'call-read-1',
                function: {
                  name: 'read_document_segments',
                  arguments: JSON.stringify({ file_id: 'demo-note', page_start: 1, page_end: 2 }),
                },
              },
              {
                id: 'call-outline-1',
                function: {
                  name: 'get_document_outline',
                  arguments: JSON.stringify({ file_id: 'demo-note' }),
                },
              },
            ],
            tool_results: [
              {
                id: 'call-read-1',
                tool: 'read_document_segments',
                result: { success: true, data: { segments: 2, summary: 'Loaded current note paragraphs.' } },
              },
              {
                id: 'call-outline-1',
                tool: 'get_document_outline',
                result: { success: true, data: { headings: ['Demo Heading', 'Next Steps'] } },
              },
            ],
          },
        };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}
EOF2

page_shot "01-home-overview.png" >/dev/null

run_code <<'EOF2'
async (page) => {
  const add = page.locator('button[title="Add at current path"]').first();
  await add.click();
}
EOF2
page_shot "02-root-add-menu.png" >/dev/null

run_code <<'EOF2'
async (page) => {
  await page.getByRole('button', { name: 'New File' }).first().click();
}
EOF2
page_shot "03-new-file-dialog.png" >/dev/null

run_code <<EOF2
async (page) => {
  const closeDialog = page.getByRole('button', { name: 'Cancel' }).first();
  if (await closeDialog.count()) await closeDialog.click();

  const add = page.locator('button[title="Add at current path"]').first();

  await add.click();
  await page.getByRole('button', { name: 'New Folder' }).first().click();
  await page.locator('form input[type="text"]').last().fill('${MANUAL_FOLDER}');
  await page.getByRole('button', { name: 'Create' }).click();

  await add.click();
  await page.getByRole('button', { name: 'New File' }).first().click();
  await page.locator('form input[type="text"]').last().fill('${MANUAL_NOTE}');
  await page.getByRole('button', { name: 'Create' }).click();

  await add.click();
  await page.getByRole('button', { name: 'New File' }).first().click();
  await page.locator('form input[type="text"]').last().fill('${MANUAL_REF}');
  await page.getByRole('button', { name: 'Create' }).click();

  await add.click();
  await page.getByRole('button', { name: 'New Session' }).first().click();
  await page.locator('form input[type="text"]').last().fill('${MANUAL_SESSION}');
  await page.getByRole('button', { name: 'Create' }).click();

  const uploadInput = page.locator('input[type="file"][accept=".md,.txt,.pdf"]').first();
  await uploadInput.setInputFiles('test_sample.pdf');

  await page.locator('span.truncate', { hasText: '${MANUAL_PDF}' }).first().waitFor({ timeout: 20000 });
}
EOF2

run_code <<EOF2
async (page) => {
  const note = page.locator('span.truncate', { hasText: '${MANUAL_NOTE}' }).first();
  await note.click({ button: 'right' });
}
EOF2
page_shot "04-file-context-menu.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.mouse.click(1200, 120);
  await page.locator('span.truncate', { hasText: '${MANUAL_NOTE}' }).first().click();
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ timeout: 15000 });
  await editor.click();
  await page.keyboard.press('Meta+a').catch(async () => page.keyboard.press('Control+a'));
  await page.keyboard.type('# Demo Heading\n\nThis note is used for the user manual.\n\n- First step\n- Second step\n\nCode sample\n');
  await page.waitForTimeout(1200);
}
EOF2
page_shot "05-markdown-editor.png" >/dev/null

run_code <<EOF2
async (page) => {
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await page.keyboard.press('Meta+a').catch(async () => page.keyboard.press('Control+a'));
  await editor.click({ button: 'right' });
}
EOF2
page_shot "06-selection-context-menu.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.getByRole('button', { name: 'Open Temporary Dialog (Fix / Check)' }).click();
  await page.getByRole('button', { name: 'Check Selection' }).click();
  await page.getByText('Sent to session').waitFor({ timeout: 10000 });
}
EOF2
page_shot "07-temp-dialog.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('span.truncate', { hasText: '${MANUAL_REF}' }).first().click();
  const pdfItem = page.locator('span.truncate').filter({ hasText: '.pdf' }).first();
  await pdfItem.click();
  await page.locator('span.truncate', { hasText: '${MANUAL_SESSION}' }).first().click();

  const split = page.locator('button[title="Split Pane"]').first();
  await split.click();
  await page.waitForTimeout(200);
  await split.click();
  await page.waitForTimeout(400);

  const noteTab = page.locator('div[draggable="true"]').filter({ hasText: '${MANUAL_NOTE}' }).first();
  const sessionTab = page.locator('div[draggable="true"]').filter({ hasText: '${MANUAL_SESSION}' }).first();
  const emptyPanes = page.locator('div.flex-1.min-w-\\[320px\\]:has-text("Empty Pane")');
  await noteTab.dragTo(emptyPanes.nth(0));
  await page.waitForTimeout(300);
  await sessionTab.dragTo(emptyPanes.nth(0));
  await page.waitForTimeout(500);
}
EOF2
page_shot "08-multi-pane-layout.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.locator('div[draggable="true"]').filter({ hasText: '${MANUAL_SESSION}' }).first().click();

  const buttons = page.locator('[data-context-file-id] button[title]');
  const notePermission = page.locator('[data-context-file-name="${MANUAL_NOTE}"] button[title]').first();
  const refPermission = page.locator('[data-context-file-name="${MANUAL_REF}"] button[title]').first();
  const pdfPermission = page.locator('[data-context-file-name="${MANUAL_PDF}"] button[title]').first();

  if ((await notePermission.getAttribute('title')) !== 'Write permission') {
    await notePermission.click();
    await page.waitForTimeout(300);
  }
  if (await pdfPermission.count() && (await pdfPermission.getAttribute('title')) !== 'Hidden from AI') {
    await pdfPermission.click();
    await page.waitForTimeout(300);
  }
  // Keep manual-ref as default read.

  const chatInput = page.locator('textarea[placeholder^="Type a message"]').first();
  await chatInput.fill('请演示一下你会如何阅读当前可见文件。');
  await chatInput.press('Enter');
  await page.getByText('这是演示用回复').waitFor({ timeout: 20000 });
}
EOF2
page_shot "09-session-chat-and-permissions.png" >/dev/null

run_code <<EOF2
async (page) => {
  const preferredPdfTab = page.locator('div[draggable="true"]').filter({ hasText: '${MANUAL_PDF}' }).first();
  if (await preferredPdfTab.count()) {
    await preferredPdfTab.click();
  } else {
    await page.locator('div[draggable="true"]').filter({ hasText: '.pdf' }).first().click();
  }
  await page.locator('button[title="Next page"]').first().waitFor({ timeout: 20000 });
  await page.locator('button[title="Next page"]').first().click();
  await page.waitForTimeout(500);
}
EOF2
page_shot "10-pdf-viewer.png" >/dev/null

NOTE_ID="$(MANUAL_NOTE="${MANUAL_NOTE}" node_fetch <<'EOF2'
const res = await fetch('http://127.0.0.1:8000/api/v1/files/');
const json = await res.json();
const files = json?.data?.files || [];
const file = files.find((item) => item.name === process.env.MANUAL_NOTE);
console.log(file?.id || '');
EOF2
)"

if [ -z "$NOTE_ID" ]; then
  echo "Failed to locate manual note id" >&2
  exit 1
fi

NOTE_ID="$NOTE_ID" node_fetch <<'EOF2'
const noteId = process.env.NOTE_ID;
const newContent = [
  '# Demo Heading',
  '',
  'This note is used for the user manual.',
  '',
  '## Agent Revision',
  '',
  '```python',
  'print("manual diff")',
  '```',
  '',
  '公式：$E=mc^2$',
].join('\n');

await fetch(`http://127.0.0.1:8000/api/v1/files/${noteId}/diff-events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    new_content: newContent,
    summary: 'Manual screenshot diff',
    author: 'agent',
  }),
});
EOF2

run_code <<EOF2
async (page) => {
  await page.reload();
  await page.locator('span.truncate', { hasText: '${MANUAL_NOTE}' }).first().click();
  await page.getByRole('button', { name: 'Accept All' }).first().waitFor({ timeout: 15000 });
}
EOF2
page_shot "11-pending-diff.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.getByRole('button', { name: 'Accept All' }).first().click();
  await page.waitForTimeout(800);
  const timelineHeader = page.getByText('Timeline', { exact: true }).first();
  await timelineHeader.click();
  await page.waitForTimeout(600);
}
EOF2
page_shot "12-timeline.png" >/dev/null

run_code <<EOF2
async (page) => {
  await page.locator('text=Accept all pending diff lines').first().click();
  await page.getByRole('button', { name: 'Exit Diff' }).waitFor({ timeout: 15000 });
}
EOF2
page_shot "13-version-diff.png" >/dev/null

"$PWCLI" --session "$SESSION" close >/dev/null || true

echo "Screenshots written to $OUT_DIR"
