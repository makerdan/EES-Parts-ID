#!/usr/bin/env bash
# Unit tests for the check_api_health function in scripts/post-merge.sh.
#
# Mocks:
#   curl  — reads pre-programmed responses from temp files; a file-backed
#           counter survives nested sub-subshells created by $(...).
#   sleep — no-op so the suite finishes instantly.
#
# Usage:  bash scripts/test-post-merge.sh
# Exit:   0 if all tests pass, 1 if any test fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Test harness helpers
# ---------------------------------------------------------------------------
PASS=0
FAIL=0

pass() { echo "PASS: $1"; ((PASS++)) || true; }
fail() { echo "FAIL: $1"; ((FAIL++)) || true; }

assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    pass "$name"
  else
    fail "$name (expected exit $expected, got $actual)"
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$name"
  else
    fail "$name (expected to find: $needle)"
  fi
}

# ---------------------------------------------------------------------------
# Source the function under test.
# The BASH_SOURCE guard in post-merge.sh prevents the main block from running.
# We set REPLIT_DEV_DOMAIN so the variable expansion in post-merge.sh is safe.
# ---------------------------------------------------------------------------
export REPLIT_DEV_DOMAIN="mock-domain.test"

# shellcheck source=post-merge.sh
source "$SCRIPT_DIR/post-merge.sh"
# post-merge.sh enables set -e for production safety; disable it here so that
# check_api_health returning 1 (expected in failure tests) does not abort this
# test runner.
set +e

# Silence sleep throughout all tests — we don't need real delays.
sleep() { :; }

# ---------------------------------------------------------------------------
# File-backed mock for curl.
#
# check_api_health calls curl inside a $(...) command substitution, which
# spawns a sub-subshell.  A plain shell variable used as a call counter would
# lose its increments when that sub-subshell exits.  Writing the counter to a
# temp file makes it visible to every level of subshell.
#
# Layout under MOCK_DIR:
#   count          — current call index (0-based), one integer per line
#   response_N     — body to echo on the Nth call (0-indexed)
#   total          — number of pre-programmed responses
# ---------------------------------------------------------------------------
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

reset_mock() {
  echo 0 > "$MOCK_DIR/count"
  local i=0
  for response in "$@"; do
    printf '%s' "$response" > "$MOCK_DIR/response_${i}"
    ((i++)) || true
  done
  echo "$i" > "$MOCK_DIR/total"
}

curl() {
  local count total response
  count=$(cat "$MOCK_DIR/count")
  total=$(cat "$MOCK_DIR/total")
  if [[ "$count" -lt "$total" ]]; then
    response=$(cat "$MOCK_DIR/response_${count}" 2>/dev/null || true)
  else
    response=""
  fi
  echo $((count + 1)) > "$MOCK_DIR/count"
  echo "$response"
}

# ---------------------------------------------------------------------------
# Test 1: Immediate success
# curl returns {"status":"ok"} on the very first call.
# check_api_health should return 0 after exactly 1 attempt.
# ---------------------------------------------------------------------------
reset_mock '{"status":"ok"}'
OUTPUT=$(check_api_health "test-immediate" 2>&1)
assert_exit     "immediate success — exit 0"       0 $?
assert_contains "immediate success — healthy msg"  'API Server is healthy' "$OUTPUT"

ATTEMPTS=$(echo "$OUTPUT" | grep -c "Health check attempt" || true)
assert_exit     "immediate success — only 1 attempt" 1 "$ATTEMPTS"

# ---------------------------------------------------------------------------
# Test 2: All retries exhausted (never healthy)
# curl always returns an empty body.
# check_api_health should exhaust MAX_RETRIES and return 1.
# ---------------------------------------------------------------------------
reset_mock "" "" "" "" "" ""
OUTPUT=$(check_api_health "test-all-fail" 2>&1)
assert_exit     "all retries fail — exit 1"             1 $?
assert_contains "all retries fail — attempt logged" "attempt ${MAX_RETRIES}/${MAX_RETRIES}" "$OUTPUT"

# ---------------------------------------------------------------------------
# Test 3: Recovery on the third attempt
# curl fails twice, then succeeds on attempt 3.
# check_api_health should return 0 without exhausting all retries.
# ---------------------------------------------------------------------------
reset_mock "" "" '{"status":"ok"}' "" "" ""
OUTPUT=$(check_api_health "test-recovery" 2>&1)
assert_exit     "recovery on attempt 3 — exit 0"       0 $?
assert_contains "recovery on attempt 3 — healthy msg"  'API Server is healthy' "$OUTPUT"

ATTEMPTS=$(echo "$OUTPUT" | grep -c "Health check attempt" || true)
assert_exit     "recovery on attempt 3 — stopped at 3" 3 "$ATTEMPTS"

# ---------------------------------------------------------------------------
# Test 4: Body that contains "status" but not the exact pattern is rejected
# Ensures the grep match is not fooled by {"status":"error"} or similar.
# ---------------------------------------------------------------------------
reset_mock '{"status":"error"}' '{"status":"error"}' '{"status":"error"}' \
           '{"status":"error"}' '{"status":"error"}' '{"status":"error"}'
OUTPUT=$(check_api_health "test-wrong-body" 2>&1)
assert_exit "wrong body rejected — exit 1" 1 $?

# ---------------------------------------------------------------------------
# Test 5: Extra fields in the JSON body still match
# {"status":"ok","uptime":123} must be accepted.
# ---------------------------------------------------------------------------
reset_mock '{"status":"ok","uptime":123}'
OUTPUT=$(check_api_health "test-extra-fields" 2>&1)
assert_exit "extra JSON fields accepted — exit 0" 0 $?

# ---------------------------------------------------------------------------
# Test 6: post-merge.sh contains the codegen step
# Ensures the codegen command is present in the script and appears before
# the first health check so generated files are always fresh after a merge.
# ---------------------------------------------------------------------------
SCRIPT_CONTENT=$(cat "$SCRIPT_DIR/post-merge.sh")

if echo "$SCRIPT_CONTENT" | grep -qE 'api-spec (run codegen|exec orval)'; then
  pass "codegen — command present in post-merge.sh"
else
  fail "codegen — command missing from post-merge.sh"
fi

# Verify codegen line appears before the first health check invocation.
CODEGEN_LINE=$(grep -nE 'api-spec (run codegen|exec orval)' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
HEALTHCHECK_LINE=$(grep -n 'check_api_health' "$SCRIPT_DIR/post-merge.sh" | grep -v '^[0-9]*:.*()' | head -1 | cut -d: -f1)
if [[ -n "$CODEGEN_LINE" && -n "$HEALTHCHECK_LINE" && "$CODEGEN_LINE" -lt "$HEALTHCHECK_LINE" ]]; then
  pass "codegen — runs before health check"
else
  fail "codegen — must appear before first check_api_health call (codegen=$CODEGEN_LINE, healthcheck=$HEALTHCHECK_LINE)"
fi

# ---------------------------------------------------------------------------
# Test 7: codegen command is wrapped with a timeout guard
# Ensures the codegen step cannot hang indefinitely and block future merges.
# ---------------------------------------------------------------------------
CODEGEN_TIMEOUT_LINE=$(grep -nE 'timeout.*api-spec (run codegen|exec orval)' "$SCRIPT_DIR/post-merge.sh" | head -1)
if [[ -n "$CODEGEN_TIMEOUT_LINE" ]]; then
  pass "codegen — wrapped with timeout guard"
else
  fail "codegen — must be wrapped with 'timeout <N> pnpm --filter @workspace/api-spec (run codegen|exec orval)'"
fi

# Verify the timeout value does not exceed 120 seconds.
TIMEOUT_VALUE=$(echo "$CODEGEN_TIMEOUT_LINE" | grep -oP 'timeout \K[0-9]+' || true)
if [[ -n "$TIMEOUT_VALUE" && "$TIMEOUT_VALUE" -le 120 ]]; then
  pass "codegen — timeout value is ≤120s (got ${TIMEOUT_VALUE}s)"
else
  fail "codegen — timeout value must be ≤120s (got '${TIMEOUT_VALUE:-not found}')"
fi

# ---------------------------------------------------------------------------
# Test 8: Metro port-conflict guards are present in parts-id
#
# Verifies that the two runtime guards preventing Metro from hanging on a
# port conflict have not been accidentally removed:
#   (a) the dev script in package.json must contain --port $PORT and
#       --non-interactive
#   (b) artifact.toml [services.env] must declare EXPO_NO_INTERACTIVE = "1"
# ---------------------------------------------------------------------------
PARTS_PKG="$SCRIPT_DIR/../artifacts/parts-id/package.json"
PARTS_TOML="$SCRIPT_DIR/../artifacts/parts-id/.replit-artifact/artifact.toml"

if [[ -f "$PARTS_PKG" ]]; then
  DEV_SCRIPT=$(grep -E '"dev"\s*:' "$PARTS_PKG" || true)

  if echo "$DEV_SCRIPT" | grep -q -- '--port \$PORT'; then
    pass "metro-port-guard — --port \$PORT present in parts-id dev script"
  else
    fail "metro-port-guard — --port \$PORT MISSING from parts-id dev script"
  fi

  if echo "$DEV_SCRIPT" | grep -qE 'CI=1|--non-interactive'; then
    pass "metro-port-guard — non-interactive flag (CI=1 or --non-interactive) present in parts-id dev script"
  else
    fail "metro-port-guard — non-interactive flag (CI=1 or --non-interactive) MISSING from parts-id dev script"
  fi
else
  fail "metro-port-guard — artifacts/parts-id/package.json not found"
fi

if [[ -f "$PARTS_TOML" ]]; then
  if grep -q 'EXPO_NO_INTERACTIVE\s*=\s*"1"' "$PARTS_TOML"; then
    pass "metro-port-guard — EXPO_NO_INTERACTIVE = \"1\" present in artifact.toml"
  else
    fail "metro-port-guard — EXPO_NO_INTERACTIVE = \"1\" MISSING from artifact.toml [services.env]"
  fi
else
  fail "metro-port-guard — artifacts/parts-id/.replit-artifact/artifact.toml not found"
fi

# ---------------------------------------------------------------------------
# Test 9: pnpm install is wrapped with a timeout guard and runs in background
# Ensures install cannot hang indefinitely and does not block the health check
# within the 20s platform budget.
# ---------------------------------------------------------------------------
SCRIPT_CONTENT=$(cat "$SCRIPT_DIR/post-merge.sh")

if echo "$SCRIPT_CONTENT" | grep -qP 'timeout\s+[0-9]+\s+.*pnpm install'; then
  pass "pnpm install — wrapped with timeout guard"
else
  fail "pnpm install — must be wrapped with 'timeout <N> ... pnpm install'"
fi

INSTALL_TIMEOUT_LINE=$(grep -n 'timeout.*pnpm install' "$SCRIPT_DIR/post-merge.sh" | head -1)
INSTALL_TIMEOUT_VALUE=$(echo "$INSTALL_TIMEOUT_LINE" | grep -oP 'timeout \K[0-9]+' || true)
if [[ -n "$INSTALL_TIMEOUT_VALUE" && "$INSTALL_TIMEOUT_VALUE" -le 120 ]]; then
  pass "pnpm install — timeout value is ≤120s (got ${INSTALL_TIMEOUT_VALUE}s)"
else
  fail "pnpm install — timeout value must be ≤120s (got '${INSTALL_TIMEOUT_VALUE:-not found}')"
fi

# Install must run in the background (trailing &) so it does not block the
# health check within the 20s platform post-merge budget.
if echo "$SCRIPT_CONTENT" | grep -qP 'pnpm install.*&\s*$'; then
  pass "pnpm install — runs in background (non-blocking)"
else
  fail "pnpm install — must run in background with trailing & to avoid blocking health check"
fi

# ---------------------------------------------------------------------------
# Test 10: pnpm install in background — script continues and exits 0
# Verifies that when the lockfile changes the script still exits 0 (install
# is fire-and-forget; failure is logged to /tmp, not fatal to post-merge).
# ---------------------------------------------------------------------------
MOCK_BIN_DIR=$(mktemp -d)
# Mock `timeout` that exits 0 immediately (background install completes fast).
cat > "$MOCK_BIN_DIR/timeout" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR/timeout"
# Mock `git` to report that pnpm-lock.yaml changed so the conditional install
# branch is always taken, regardless of the actual repo state during tests.
cat > "$MOCK_BIN_DIR/git" << 'MOCKEOF'
#!/bin/bash
echo "pnpm-lock.yaml"
MOCKEOF
chmod +x "$MOCK_BIN_DIR/git"
# Mock `curl` to return a healthy response so the health check passes.
cat > "$MOCK_BIN_DIR/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR/curl"

INSTALL_BG_OUTPUT=$(PATH="$MOCK_BIN_DIR:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
INSTALL_BG_EXIT=$?
rm -rf "$MOCK_BIN_DIR"

assert_exit     "install timeout — exits non-zero"         0 "$INSTALL_BG_EXIT"
assert_contains "install timeout — prints timeout message" "background" "$INSTALL_BG_OUTPUT"

# ---------------------------------------------------------------------------
# Test 11: verify-fts step is present in post-merge.sh
# Ensures the FTS index check is wired into the deploy flow and cannot
# be accidentally removed without the test suite catching it.
# ---------------------------------------------------------------------------
SCRIPT_CONTENT=$(cat "$SCRIPT_DIR/post-merge.sh")

if echo "$SCRIPT_CONTENT" | grep -q 'verify-fts'; then
  pass "verify-fts — command present in post-merge.sh"
else
  fail "verify-fts — command missing from post-merge.sh"
fi

# Verify it runs after the DB push so the index is fresh before we check it.
PUSH_LINE=$(grep -n 'pnpm --filter db push' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
VERIFY_LINE=$(grep -n 'verify-fts' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
if [[ -n "$PUSH_LINE" && -n "$VERIFY_LINE" && "$VERIFY_LINE" -gt "$PUSH_LINE" ]]; then
  pass "verify-fts — runs after db push"
else
  fail "verify-fts — must appear after 'pnpm --filter db push' (push=$PUSH_LINE, verify=$VERIFY_LINE)"
fi

# ---------------------------------------------------------------------------
# Test 12: db push is skipped when no schema files changed
# Runs post-merge.sh as a subprocess with a mock git that reports only
# non-schema changed files, and a mock pnpm that records whether it was
# called with the db push arguments.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR2=$(mktemp -d)
DB_PUSH_CALLED_FILE="$MOCK_BIN_DIR2/db_push_called"

cat > "$MOCK_BIN_DIR2/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR2/git"

cat > "$MOCK_BIN_DIR2/pnpm" << MOCKEOF
#!/bin/bash
# Record if db push was attempted
if echo "\$*" | grep -q 'push'; then
  touch "$DB_PUSH_CALLED_FILE"
fi
# Let verify-fts and orval succeed silently
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR2/pnpm"

cat > "$MOCK_BIN_DIR2/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR2/curl"

SKIP_DB_OUTPUT=$(PATH="$MOCK_BIN_DIR2:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
SKIP_DB_EXIT=$?
rm -rf "$MOCK_BIN_DIR2"

assert_exit     "db push skip — exits 0 when schema unchanged" 0 "$SKIP_DB_EXIT"
assert_contains "db push skip — prints skip message" "Schema unchanged — skipping db push and FTS check" "$SKIP_DB_OUTPUT"

# ---------------------------------------------------------------------------
# Test 13: db push runs when schema files changed
# Runs post-merge.sh with a mock git that reports a schema file changed.
# The mock pnpm records whether db push was called.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR3=$(mktemp -d)
DB_PUSH_CALLED_FILE3="$MOCK_BIN_DIR3/db_push_called"

cat > "$MOCK_BIN_DIR3/git" << 'MOCKEOF'
#!/bin/bash
echo "lib/db/src/schema/inventory.ts"
MOCKEOF
chmod +x "$MOCK_BIN_DIR3/git"

cat > "$MOCK_BIN_DIR3/timeout" << MOCKEOF
#!/bin/bash
# Capture args: first arg is the timeout value, rest is the command
shift
# Record if this is a db push call
if echo "\$*" | grep -q 'push'; then
  touch "$DB_PUSH_CALLED_FILE3"
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR3/timeout"

cat > "$MOCK_BIN_DIR3/pnpm" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR3/pnpm"

cat > "$MOCK_BIN_DIR3/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR3/curl"

SCHEMA_DB_OUTPUT=$(PATH="$MOCK_BIN_DIR3:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
SCHEMA_DB_EXIT=$?
rm -rf "$MOCK_BIN_DIR3"

assert_exit     "db push run — exits 0 when schema changed" 0 "$SCHEMA_DB_EXIT"
assert_contains "db push run — prints running message" "Schema changed — running db push" "$SCHEMA_DB_OUTPUT"

# ---------------------------------------------------------------------------
# Test 14: @workspace/api-client-react package.json resolution fields
#
# Verifies that the package exports a valid entry-point AND declares a
# "types" field so TypeScript can resolve the module regardless of
# moduleResolution strategy.  A missing "types" field with only an
# "exports" field is the root cause of the 104 TS2305 errors that
# previously broke 38 files in parts-id.
# ---------------------------------------------------------------------------
API_CLIENT_PKG="$SCRIPT_DIR/../lib/api-client-react/package.json"

if [[ -f "$API_CLIENT_PKG" ]]; then
  # Extract the effective type-resolution path from exports['.'].
  # exports['.'] may be a string (legacy) or a conditions object
  # {"types":"./dist/index.d.ts","default":"./src/index.ts"}.
  # In both cases we resolve the "types" condition (or the string itself)
  # as the path TypeScript will actually load.
  EXPORTS_ENTRY=$(node -e \
    "const p=JSON.parse(require('fs').readFileSync('$API_CLIENT_PKG','utf8')); \
     const e=p.exports && p.exports['.']; \
     if (!e) { console.log(''); } \
     else if (typeof e === 'string') { console.log(e); } \
     else { console.log(e.types || e.default || e.import || ''); }" 2>/dev/null || true)

  if [[ -n "$EXPORTS_ENTRY" ]]; then
    pass "api-client-react — exports['.'] field is set (${EXPORTS_ENTRY})"
  else
    fail "api-client-react — exports['.'] field is missing or empty (TS2305 breakage risk)"
  fi

  TYPES_FIELD=$(node -e \
    "const p=JSON.parse(require('fs').readFileSync('$API_CLIENT_PKG','utf8')); \
     console.log(p.types || p.main || '')" 2>/dev/null || true)

  if [[ -n "$TYPES_FIELD" ]]; then
    pass "api-client-react — types or main field is set (${TYPES_FIELD})"
  else
    fail "api-client-react — neither 'types' nor 'main' field is set; TypeScript resolution may fail when moduleResolution does not follow exports"
  fi

  EXPORTS_SRC="$SCRIPT_DIR/../lib/api-client-react/${EXPORTS_ENTRY}"
  if [[ -f "$EXPORTS_SRC" ]]; then
    pass "api-client-react — exports['.'] target file exists"
  else
    fail "api-client-react — exports['.'] target '${EXPORTS_ENTRY}' does not exist on disk"
  fi
else
  fail "api-client-react — lib/api-client-react/package.json not found"
fi

# ---------------------------------------------------------------------------
# Test 15: parts-id typecheck exits 0
#
# Runs tsc --noEmit inside artifacts/parts-id and asserts that there are
# zero errors.  This is the direct regression guard for TS2305 "no exported
# member" and TS7006 "implicit any" errors that previously prevented the
# typecheck quality gate from passing.
#
# Build workspace lib declarations before typechecking.
# This ensures dist/ declaration files are up to date so tsc --noEmit reads
# stable compiled .d.ts files rather than the volatile generated TS source
# files that codegen:check may clean concurrently in the validation framework.
#
# Retry up to 3 times: if codegen:check is running concurrently and orval
# deletes src/generated/ mid-run, tsc --build can hit TS6307.  Retrying
# waits for orval to finish writing so the second attempt always succeeds.
# ---------------------------------------------------------------------------
for _attempt in 1 2 3; do
  pnpm -w run typecheck:libs > /dev/null 2>&1 && break
  sleep 2
done
TYPECHECK_OUTPUT=$(pnpm --filter @workspace/parts-id run typecheck 2>&1)
TYPECHECK_EXIT=$?
assert_exit "typecheck — parts-id tsc --noEmit exits 0" 0 "$TYPECHECK_EXIT"
if [[ "$TYPECHECK_EXIT" -ne 0 ]]; then
  echo "  typecheck output (first 20 lines):"
  echo "$TYPECHECK_OUTPUT" | head -20 | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 16: codegen:check no-drift path — post-merge exits 0 with success msg
#
# Spawns post-merge.sh with a mock pnpm that accepts 'run codegen:check' and
# exits 0 (simulating the in-sync case where orval + git diff produce no
# changes).  Asserts that post-merge itself exits 0 and prints the
# "drift check passed" success message, verifying that the codegen guard
# does not block merges when the generated files are already up to date.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR16=$(mktemp -d)
CODEGEN_CHECK_CALLED_FILE16="$MOCK_BIN_DIR16/codegen_check_called"

# git: report no lockfile or schema changes so those branches are skipped.
cat > "$MOCK_BIN_DIR16/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR16/git"

# pnpm: record when codegen:fix is invoked; exit 0 for everything.
cat > "$MOCK_BIN_DIR16/pnpm" << MOCKEOF
#!/bin/bash
if echo "\$*" | grep -q 'codegen:fix'; then
  touch "$CODEGEN_CHECK_CALLED_FILE16"
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR16/pnpm"

# curl: return a healthy response so check_api_health exits 0 immediately.
cat > "$MOCK_BIN_DIR16/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR16/curl"

CODEGEN_NO_DRIFT_OUTPUT=$(PATH="$MOCK_BIN_DIR16:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
CODEGEN_NO_DRIFT_EXIT=$?

if [[ -f "$CODEGEN_CHECK_CALLED_FILE16" ]]; then
  pass "codegen:fix no-drift — pnpm run codegen:fix was invoked"
else
  fail "codegen:fix no-drift — pnpm run codegen:fix was never invoked"
fi

rm -rf "$MOCK_BIN_DIR16"

assert_exit     "codegen:fix no-drift — post-merge exits 0"         0 "$CODEGEN_NO_DRIFT_EXIT"
assert_contains "codegen:fix no-drift — prints drift auto-committed msg"  "drift auto-committed" "$CODEGEN_NO_DRIFT_OUTPUT"

# ---------------------------------------------------------------------------
# Test 17: codegen:fix commit failure — post-merge exits non-zero
#
# Spawns post-merge.sh with a mock pnpm that exits 1 when codegen:fix is
# invoked, simulating a git commit failure (index lock, identity misconfigured,
# etc.).  Asserts that post-merge itself exits non-zero so the operator knows
# the auto-commit did not happen rather than silently succeeding.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR17=$(mktemp -d)

# git: report no lockfile or schema changes so those branches are skipped.
cat > "$MOCK_BIN_DIR17/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR17/git"

# pnpm: exit 1 when codegen:fix is invoked to simulate a commit failure.
cat > "$MOCK_BIN_DIR17/pnpm" << 'MOCKEOF'
#!/bin/bash
if echo "$*" | grep -q 'codegen:fix'; then
  echo "[mock] codegen:fix: git commit failed: cannot lock ref" >&2
  exit 1
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR17/pnpm"

# curl: return a healthy response (should never be reached).
cat > "$MOCK_BIN_DIR17/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR17/curl"

CODEGEN_FAIL_OUTPUT=$(PATH="$MOCK_BIN_DIR17:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
CODEGEN_FAIL_EXIT=$?
rm -rf "$MOCK_BIN_DIR17"

assert_exit     "codegen:fix commit fail — post-merge exits non-zero"  1 "$CODEGEN_FAIL_EXIT"
assert_contains "codegen:fix commit fail — prints error message"       "codegen:fix failed" "$CODEGEN_FAIL_OUTPUT"

# ---------------------------------------------------------------------------
# Test 18: background install exits non-zero — script logs warning and proceeds
#
# Spawns post-merge.sh with:
#   - mock git  : reports pnpm-lock.yaml changed so the install branch is taken
#   - mock timeout: exits 1 when called for pnpm install (failed install);
#                   passes through all other timeout-wrapped commands so codegen
#                   and db-push steps succeed normally
#   - mock pnpm : exits 0 for all calls (codegen:fix, etc.)
#   - mock curl : returns '{"status":"ok"}' so the health check passes
#
# Verifies:
#   (a) the WARNING message about the non-zero install exit is logged
#   (b) post-merge proceeds to the health check and exits 0 (not aborted)
# ---------------------------------------------------------------------------
MOCK_BIN_DIR18=$(mktemp -d)

cat > "$MOCK_BIN_DIR18/git" << 'MOCKEOF'
#!/bin/bash
echo "pnpm-lock.yaml"
MOCKEOF
chmod +x "$MOCK_BIN_DIR18/git"

# timeout: exit 1 only for the pnpm install call; run everything else normally.
# The install is launched as a background job so its non-zero exit must be
# tolerated by `wait` rather than aborting the script.
cat > "$MOCK_BIN_DIR18/timeout" << 'MOCKEOF'
#!/bin/bash
shift  # drop the timeout value; $@ is now the wrapped command
if echo "$*" | grep -q 'pnpm install'; then
  exit 1
fi
# All other wrapped commands (codegen:fix, db push): run them so they can
# succeed via the mock pnpm also present on PATH.
"$@"
MOCKEOF
chmod +x "$MOCK_BIN_DIR18/timeout"

cat > "$MOCK_BIN_DIR18/pnpm" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR18/pnpm"

cat > "$MOCK_BIN_DIR18/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR18/curl"

INSTALL_FAIL_OUTPUT=$(PATH="$MOCK_BIN_DIR18:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
INSTALL_FAIL_EXIT=$?
rm -rf "$MOCK_BIN_DIR18"

assert_exit     "install fail — script exits 0 (warning, not abort)"          0 "$INSTALL_FAIL_EXIT"
assert_contains "install fail — WARNING message logged"                        "WARNING: background install exited" "$INSTALL_FAIL_OUTPUT"
assert_contains "install fail — proceeds to health check after install wait"   "health check" "$INSTALL_FAIL_OUTPUT"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed."
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
