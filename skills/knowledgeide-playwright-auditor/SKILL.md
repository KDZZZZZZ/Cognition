---
name: knowledgeide-playwright-auditor
description: Run Playwright end-to-end audits for this KnowledgeIDE repository. Use when validating or debugging the full real-user workflow, including task-registry/step-catalog flows, viewport grounding, permissions, pending diffs, and compact continuity.
---

# KnowledgeIDE Playwright Auditor

Execute repository Playwright audits, capture regressions, and write evidence-backed reports.

## Default Workflow

1. Run the legacy full workflow audit:
`node skills/knowledgeide-playwright-auditor/scripts/run-flow-audit.mjs`

2. For real-model audits, set:
- `E2E_REAL_LLM=true`
- `MOONSHOT_API_KEY` or `KIMI_API_KEY` or `OPENAI_API_KEY`
- optional `DEFAULT_MODEL`

3. Read generated outputs:
- legacy single audit: `reports/e2e/full-flow-audit-report.md`
- scenario suite audits: `reports/e2e/runs/<timestamp>/index.md`

## Scenario Selection

The runner now supports scenario-based execution through `E2E_AUDIT_SCENARIOS`.

Examples:
- Legacy full-flow only:
`node skills/knowledgeide-playwright-auditor/scripts/run-flow-audit.mjs`
- TB suite with real model:
`E2E_REAL_LLM=true E2E_AUDIT_SCENARIOS=tb_long_scope_notes,tb_qa_validate,tb_pending_diff_effective_note,tb_pdf_viewport_focus,tb_permission_revocation,tb_force_compact_continuity node skills/knowledgeide-playwright-auditor/scripts/run-flow-audit.mjs`

Supported scenario ids:
- `full_flow`
- `paper_summary_note`
- `tb_long_scope_notes`
- `tb_qa_validate`
- `tb_pending_diff_effective_note`
- `tb_pdf_viewport_focus`
- `tb_permission_revocation`
- `tb_force_compact_continuity`

Paper fixture override:
- `E2E_PAPER_FIXTURE_PATH` (optional, defaults to the latest uploaded paper under `backend/uploads/`, preferring `2502.09992v3.pdf`)

## TB Fixture Flow

When any `tb_*` scenario is requested, the runner automatically prepares the textbook fixture by executing:
`node e2e-tests/scripts/prepare-textbook-fixture.mjs`

Defaults:
- source PDF: `/Users/kaidongzhou/Downloads/概率论教程 (钟开莱,  吴让泉) (z-library.sk, 1lib.sk, z-lib.sk).pdf`
- local fixture PDF: `e2e-tests/local-fixtures/textbooks/probability-tutorial.pdf`
- manifest: `e2e-tests/fixtures/textbooks/probability-tutorial.manifest.json`

Overrides:
- `E2E_TEXTBOOK_SOURCE_PDF`
- `E2E_TEXTBOOK_FIXTURE_PATH`
- `E2E_TEXTBOOK_MANIFEST_PATH`
- `E2E_AUDIT_REPORT_DIR`

## Outputs

TB scenario reports are written to:
- `reports/e2e/runs/<timestamp>/<scenario-id>.md`
- `reports/e2e/runs/<timestamp>/<scenario-id>.json`
- `reports/e2e/runs/<timestamp>/index.md`

Artifacts are written under:
- `reports/e2e/runs/<timestamp>/artifacts/<scenario-id>/`

## Notes

- TB audits assert against `task_registry`, not legacy `router_state`.
- Use API-assisted setup when it improves determinism, but final validation must still run through the real frontend/backend chain.
- The current textbook PDF is a scanned document; fixture preparation uses OCR-based page sampling rather than plain text extraction.
