---
name: knowledgeide-product-polisher
description: "End-to-end polishing workflow for this KnowledgeIDE repository. Use when the task requires: (1) starting backend/frontend and returning preview URLs for manual browser review, (2) drafting a target-effect checklist from the 8-step key path and iterating it after user review, (3) testing strictly against the approved checklist, and (4) implementing fixes then re-testing with console/network error inspection."
---

# KnowledgeIDE Product Polisher

Execute an explicit preview -> checklist alignment -> test -> fix -> retest loop.

## Workflow

1. Start services and return preview URLs
- Work from repo root.
- Start backend first with `python backend/main.py`.
- If `python` is unavailable, fallback to `backend/venv/bin/python` or `python3`.
- Start frontend with `npm run dev`.
- Return preview URLs for user browser validation:
  - Frontend URL
  - Backend health URL (`/health`)
  - Backend docs URL (`/docs`)
- Keep services running while the user manually reviews UI behavior.

2. Draft target-effect checklist, then align with user intent
- Produce `Target Checklist v1` using the 8-step key path in `references/key-path-checklist.md`.
- Write each checkpoint with:
  - expected behavior
  - visible UI evidence
  - pass/fail condition
- Ask user to review and modify checklist items.
- After user feedback, produce `Target Checklist v2` that integrates missing intent and clarifies ambiguous expectations.
- Do not start formal testing until checklist is approved by user.

3. Test against approved checklist
- Run baseline audit with `scripts/run-keypath-audit.sh` (or `npm run e2e:audit`).
- If needed, run focused manual checks for the exact checklist items.
- Record which checklist items pass/fail and attach evidence paths.

4. Fix issues and retest with console/network focus
- Implement code fixes for failed checklist items.
- Re-run the same checklist tests after each meaningful fix.
- Always inspect and report:
  - browser console errors/warnings
  - network errors (4xx/5xx/request failed)
- Do not mark task complete if checklist fails or critical console/network errors remain unaddressed.

5. Deliverables
- Provide:
  - final approved checklist
  - baseline test result
  - fix summary (files + behavior change)
  - post-fix retest result
  - console/network error summary and disposition

## Non-negotiables

- Preserve key-path controls and labels used by tests:
  - `Split Pane`
  - `New Folder`
  - `New Session`
  - `Accept`, `Reject`, `Accept All`, `Reject All`
  - `Exit Diff`
- Keep hidden-file permission filtering correct.
- Keep markdown + code block + math block rendering in note and diff views.

## Resources

- 8-step acceptance base: `references/key-path-checklist.md`
- Checklist drafting template: `references/target-effect-checklist-template.md`
- Audit runner: `scripts/run-keypath-audit.sh`
