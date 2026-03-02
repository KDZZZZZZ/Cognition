#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

echo "[keypath] Running KnowledgeIDE full-flow audit"

echo "[keypath] Expected dev commands:"
echo "  backend: python backend/main.py"
echo "  frontend: npm run dev"

echo "[keypath] Executing npm run e2e:audit"
npm run e2e:audit

echo "[keypath] Report: reports/e2e/full-flow-audit-report.md"
