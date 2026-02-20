# Audit Checklist

## Mandatory Flow (1-8)

1. Start backend and frontend.
2. Create a new folder.
3. Upload two local PDFs, create one note, create one session.
4. Create three panes, then drag PDF, note, and session into different panes.
5. Hide one PDF in session permissions, then ask agent to list visible files.
6. Ask agent to write summary notes based on current reading context, then verify immediate diff rendering in note view with Markdown rendering preserved.
7. Run line-level reject first, then top-level "Accept All" from the note view diff controls.
8. Open version diff view and check consistency for code blocks, math blocks, and current vs history content.

## Required Report Path

- Always write the audit report to: `reports/e2e/full-flow-audit-report.md`
- Always include:
  - pass/fail status for each mandatory step
  - concrete failure evidence (selectors, errors, or screenshots)
  - console errors and network errors
  - explicit implementation risks and UX impact

## Expansion Rules

- Expand checks automatically when instability is detected.
- Add at least one extra check in each run:
  - permission payload consistency (`context_files` vs visible permission controls)
  - network/API error regression
  - UI responsiveness or interaction friction
