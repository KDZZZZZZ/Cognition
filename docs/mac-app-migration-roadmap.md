# KnowledgeIDE Mac App Migration Roadmap

This repository is currently a Web app (React + FastAPI). The migration strategy is:

1. Stabilize Web flow (done continuously with e2e audit)
2. Prepare runtime boundaries (API/WS/config/data path)
3. Add desktop shell (recommended: Tauri)
4. Bundle backend process + assets
5. Re-run the same key-path regression in desktop mode

## Current readiness

- Core 8-step key path has automated Playwright coverage:
  - `e2e-tests/full-flow-audit.spec.ts`
- Audit runner:
  - `npm run e2e:audit`
- Product-polish skill:
  - `skills/knowledgeide-product-polisher/`

## Why Tauri first

- Smaller app size and lower idle memory than Electron.
- Native macOS packaging and signing pipeline support.
- Can run Python backend as a sidecar process.

## Required migration constraints

- Keep backend API contract unchanged for the first desktop milestone.
- Keep 8-step GUI key path behavior unchanged.
- Keep markdown + code + math rendering parity.
- Keep permission filtering behavior parity.

## Phase 1: Web hardening (now)

- Keep `npm run e2e:audit` green.
- Eliminate blocking startup assumptions (`python` vs `python3`, dependency drift).
- Reduce websocket warning noise where practical.

## Phase 2: Desktop-ready runtime boundaries (now in progress)

- Frontend API base URL must be runtime-injectable (not only compile-time `.env`).
- Frontend WS base URL must be runtime-injectable.
- Backend CORS should allow desktop protocols for local shell hosts.

## Phase 3: Tauri shell bootstrap

- Add `src-tauri` project.
- On app startup:
  - Start backend sidecar process (`backend/main.py` packaged runtime)
  - Wait for `/health`
  - Inject `window.__KNOWLEDGE_IDE_CONFIG__` with `apiBaseUrl`/`wsBaseUrl`
  - Load frontend bundle
- On app close:
  - Gracefully stop backend sidecar

## Phase 4: Data path and packaging

- Move mutable runtime data to app data dir (macOS):
  - sqlite db
  - uploads
  - chroma_db
- Avoid writing into app bundle path.
- Add release scripts and signing/notarization steps.

## Phase 5: Desktop regression gates

For each desktop build candidate:

1. Startup: app opens and backend sidecar healthy
2. Run the same 8-step key path in desktop window
3. Validate file upload, drag/drop, note diff actions, version diff
4. Verify no permission leakage
5. Verify packaging/install/uninstall behavior

## Immediate next implementation task

- Scaffold Tauri app and sidecar bootstrap.
- Keep Web mode unchanged.
