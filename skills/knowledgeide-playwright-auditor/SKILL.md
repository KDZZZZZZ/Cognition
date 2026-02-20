---
name: knowledgeide-playwright-auditor
description: Run Playwright end-to-end audits for this KnowledgeIDE repository. Use when validating or debugging the full real-user workflow (startup, folder/file/session creation, pane branching + drag, permission visibility, agent note edits with diff actions, and version-diff consistency), and when generating or updating the fixed report file at reports/e2e/full-flow-audit-report.md.
---

# KnowledgeIDE Playwright Auditor

Execute the repository's full user-flow audit with Playwright, capture regressions, and write findings to the fixed report path.

## Workflow

1. Run the automated flow:
`node skills/knowledgeide-playwright-auditor/scripts/run-flow-audit.mjs`

Before running, choose execution mode:
- Deterministic regression mode (default): `E2E_REAL_LLM` unset/false (chat completions are mocked in spec).
- Real model smoke mode: set `E2E_REAL_LLM=true` and provide:
  - `OPENAI_API_KEY`
  - optional `OPENAI_BASE_URL` (defaults to DashScope-compatible endpoint)
  - optional `DEFAULT_MODEL` (defaults to `qwen-plus`)

2. Use the generated report as the source of truth:
`reports/e2e/full-flow-audit-report.md`

3. Read evidence artifacts when steps fail:
`reports/e2e/artifacts/`

4. Extend checks directly in:
`e2e-tests/full-flow-audit.spec.ts`

## Mandatory Obligations

- Always evaluate all 8 core workflow checkpoints from `references/audit-checklist.md`.
- Always write the report to `reports/e2e/full-flow-audit-report.md`.
- Always include step-by-step PASS/FAIL status, failure evidence, network errors, and console errors.
- Always add at least one expanded exploratory check per run for bug discovery or UX friction detection.
- Always include these quality checks in report:
  - PDF citation quality (`[file_name p.N]` format detection)
  - PDF tool-selection evidence (`read_visible_pdf_context` / `read_pdf_pages` / `search_pdf_passages`)
  - prompt-contract violations (permission leakage / unsupported claims)

## Notes

- The audit spec uses deterministic mocked chat completion by default for repeatable regression.
- In `E2E_REAL_LLM=true`, the spec does not hijack `/chat/completions`; it performs real-chain smoke validation.
- Service startup follows the required flow (`python backend/main.py` and `npm run dev`) through the runner script.
- Treat any failing checkpoint as implementation debt; capture concrete fix recommendations in the report.

## References

- `references/audit-checklist.md`
