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

  if echo "$DEV_SCRIPT" | grep -q -- '--non-interactive'; then
    pass "metro-port-guard — --non-interactive present in parts-id dev script"
  else
    fail "metro-port-guard — --non-interactive MISSING from parts-id dev script"
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
# Test 9: pnpm install is wrapped with a timeout guard
# Ensures the install step cannot hang indefinitely and block future merges.
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

# ---------------------------------------------------------------------------
# Test 10: pnpm install timeout triggers a clear error message and non-zero exit
# Runs post-merge.sh as a subprocess with a mock `timeout` that exits 124 to
# simulate a real registry hang, and verifies the script exits 1 with the
# expected error message.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR=$(mktemp -d)
# Mock `timeout` that always exits 124 (the standard timeout expiry code).
cat > "$MOCK_BIN_DIR/timeout" << 'MOCKEOF'
#!/bin/bash
exit 124
MOCKEOF
chmod +x "$MOCK_BIN_DIR/timeout"
# Mock `sh` so the inner `sh -c 'CI=true pnpm install...'` inside our fake
# timeout never reaches a real shell (timeout exits before exec-ing it anyway,
# but guard here in case the implementation changes).
cat > "$MOCK_BIN_DIR/sh" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR/sh"
# Mock `git` to report that pnpm-lock.yaml changed so the conditional install
# branch is always taken, regardless of the actual repo state during tests.
cat > "$MOCK_BIN_DIR/git" << 'MOCKEOF'
#!/bin/bash
echo "pnpm-lock.yaml"
MOCKEOF
chmod +x "$MOCK_BIN_DIR/git"

INSTALL_TIMEOUT_OUTPUT=$(PATH="$MOCK_BIN_DIR:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
INSTALL_TIMEOUT_EXIT=$?
rm -rf "$MOCK_BIN_DIR"

assert_exit     "install timeout — exits non-zero"         1 "$INSTALL_TIMEOUT_EXIT"
assert_contains "install timeout — prints timeout message" "timed out after 120s" "$INSTALL_TIMEOUT_OUTPUT"

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
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed."
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
