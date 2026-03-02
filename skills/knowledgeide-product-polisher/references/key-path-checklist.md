# KnowledgeIDE Key Path Checklist (8 Steps)

Use this list as the acceptance contract.

1. Start app
- Backend and frontend both start.
- Explorer is visible after loading.

2. Create a new folder
- Folder appears in tree.

3. Upload two PDFs and create note/session
- Two local PDFs upload successfully.
- One note and one session are created and visible.

4. Create 3 panes and distribute items
- Use split button to create three panes.
- Drag PDF, note, and session to separate panes.

5. Hide one PDF and verify permission alignment
- Mark one PDF as hidden.
- Ask agent for visible file list.
- Hidden PDF must not be present in request context.

6. Agent writes note summary and diff appears immediately
- Ask agent to summarize current reading into note.
- Note page must show pending diff controls immediately.
- Markdown rendering remains active (code + formula).
- Manual edit still works after agent update.

7. Line-level reject, then top-level accept all
- Perform one line-level reject.
- Perform top-level accept all in note page (not version page).

8. Open version diff and verify consistency
- Enter version diff view from timeline.
- Code block and math block render correctly.
- Current content and historical snapshot relationship is consistent.

## Expanded checks

- Watch for console errors and network failures.
- Confirm hidden-file permissions are not leaked in assistant output.
- Verify PDF citation and tool usage quality when running real-model mode.
