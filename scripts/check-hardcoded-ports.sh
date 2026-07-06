#!/usr/bin/env bash
# check-hardcoded-ports.sh
#
# Guards against hardcoded port fallback literals creeping back into service
# code. Scans TypeScript, JavaScript, and MJS source files for patterns of the
# form:
#
#   process.env.PORT || "3000"
#   process.env.PORT || 3000
#   parseInt(...PORT... || "3001")
#
# Allowed exceptions (not flagged):
#   - scripts/dev-ports.json  — the canonical shared source of truth
#   - artifacts/parts-id/utils/devPorts.ts — Metro-compatible re-export
#   - Test files (*.test.ts, *.test.tsx, *.spec.ts, files under __tests__/)
#   - Compiled output (dist/, static-build/)
#   - node_modules/
#
# Remediation: add the port to scripts/dev-ports.json and import from there.
# See api-server/src/index.ts and parts-id/server/serve.js for examples.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# Pattern: PORT env-var access followed by a logical-OR fallback containing
# 4-5 digit number (covers quoted and unquoted forms).
GREP_PATTERN='PORT[^=\n]*\|\|[^|]{0,30}[0-9]{4,5}'

FOUND=$(grep -rn \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.mjs" \
  -E "$GREP_PATTERN" \
  "$ROOT/artifacts" \
  --exclude-dir=node_modules \
  --exclude-dir=static-build \
  --exclude-dir=dist \
  --exclude="*.test.ts" \
  --exclude="*.test.tsx" \
  --exclude="*.spec.ts" \
  --exclude="*.spec.tsx" \
  2>/dev/null \
  | grep -v "/__tests__/" \
  | grep -v "/utils/devPorts\.ts" \
  || true)

if [[ -n "$FOUND" ]]; then
  echo ""
  echo "ERROR: Hardcoded port fallback(s) found in service code:"
  echo "--------------------------------------------------------------"
  echo "$FOUND"
  echo "--------------------------------------------------------------"
  echo ""
  echo "Fix: Add your port to scripts/dev-ports.json (single source of truth),"
  echo "     then import it using createRequire (Node.js ESM) or require (CJS)."
  echo ""
  echo "     For Expo/Metro (mobile), add the constant to:"
  echo "       artifacts/parts-id/utils/devPorts.ts"
  echo "     and import from there (Metro cannot bundle files outside its project root)."
  echo ""
  echo "     Test-only port literals are allowed — they don't trigger this check."
  echo ""
  exit 1
fi

echo "✓ No hardcoded port fallbacks found in service code."
