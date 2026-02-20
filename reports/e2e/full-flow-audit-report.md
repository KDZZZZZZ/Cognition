# KnowledgeIDE Full-Flow Audit Report

- Started: 2026-02-20T04:25:27.339Z
- Ended: 2026-02-20T04:25:34.119Z
- Duration: 6.8s
- Result: 10 PASS / 0 FAIL / 3 WARN

## Step Results

| Step | Status | Details | Evidence |
| --- | --- | --- | --- |
| 1 Start frontend/backend and open app | PASS | Frontend loaded with explorer visible. | - |
| 2 Create a new folder | PASS | Created folder "audit-folder-1771561527339". | - |
| 3 Upload two PDFs and create one note + one session | PASS | Created note=9a3a1e6f-3e0f-4894-8a1d-aa701fed1fb8, hidden candidate pdf=7e3e97f9-91f9-4262-af13-6e8f0d3355f3. | - |
| 4 Create 3 panes and drag pdf/note/session across panes | PASS | Panes created and drag operation changed pane occupancy (2 -> 1). | - |
| 5 Hide one PDF and verify visible list from agent response | PASS | context_files excluded hidden PDF and included note. visible_count=1 | - |
| 6 Ask agent to write summary and expect immediate note diff with markdown rendering | PASS | Agent update triggered immediate diff controls with markdown rendering. | - |
| 7 Do line-level reject then top-level accept all in note view | PASS | Executed line-level reject and top-level accept-all sequence. | - |
| 8 Open version diff page and validate code/math + history consistency | PASS | Version diff opened with 1 versions and current/history mismatch verified. | - |
| X1 Expanded check: network errors | PASS | No network failures detected. | - |
| X2 Expanded check: console errors | WARN | Detected 4 console warnings/errors. | - |
| X3 Expanded check: PDF citation quality | WARN | No page-level citation pattern detected in captured assistant output. | - |
| X4 Expanded check: PDF tool selection | WARN | No PDF-specialized tool usage observed in captured tool calls. | - |
| X5 Expanded check: prompt contract violations | PASS | No obvious hidden-file leakage found in assistant output. | - |

## Captured Chat Context

- session=session_1771561528667_100, context_files=1 -> [9a3a1e6f-3e0f-4894-8a1d-aa701fed1fb8], prompt="请列出你当前可见的文件ID。"
- session=session_1771561528667_100, context_files=1 -> [9a3a1e6f-3e0f-4894-8a1d-aa701fed1fb8], prompt="请列出你当前可见的文件ID。"
- session=session_1771561528667_100, context_files=1 -> [9a3a1e6f-3e0f-4894-8a1d-aa701fed1fb8], prompt="请根据我当前阅读内容在note中写入概括，保留代码块和公式。"
- session=session_1771561528667_100, context_files=1 -> [9a3a1e6f-3e0f-4894-8a1d-aa701fed1fb8], prompt="请根据我当前阅读内容在note中写入概括，保留代码块和公式。"

## Console Issues

- [warning] WebSocket connection to 'ws://localhost:8000/ws/connect?session_id=session_1771561528667_100' failed: WebSocket is closed before the connection is established.
- [error] WebSocket error: Event
- [warning] WebSocket connection to 'ws://localhost:8000/ws/connect?session_id=session_1771561528667_100' failed: WebSocket is closed before the connection is established.
- [error] WebSocket error: Event

## Network Issues

- None

## Verdict

- Full workflow passed under current automated audit checks.
