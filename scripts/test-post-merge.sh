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
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed."
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
