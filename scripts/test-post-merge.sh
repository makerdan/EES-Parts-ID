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
  # Pure-bash substring match: `echo | grep -q` under `set -o pipefail` fails
  # spuriously when grep exits at first match and echo takes a SIGPIPE (141).
  if [[ "$haystack" == *"$needle"* ]]; then
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
# Fast environment for full-run subprocess spawns of post-merge.sh.
#
# The sleep() override above only applies to functions sourced into THIS
# shell; a spawned `bash post-merge.sh` gets the real /bin/sleep.  Without
# this, every spawn pays the 2s codegen-settle floor (~11 spawns ≈ 22s), and
# sync-github.sh performs a real network push whenever GITHUB_TOKEN is set.
#
#   CODEGEN_SETTLE_* = 0  — wait_for_codegen_settle returns immediately
#                           (sleep 0 + empty poll window); the settle
#                           behaviour itself is unit-tested via the sourced
#                           function in Tests 23/24 with mocked sleep.
#   GITHUB_TOKEN=""       — sync-github.sh's -z guard fires and it exits 0
#                           without any network call.
#
# Every subprocess spawn below is prefixed with:
#   env "${FAST_SPAWN_ENV[@]}" ...
# ---------------------------------------------------------------------------
FAST_SPAWN_ENV=(
  CODEGEN_SETTLE_FLOOR_SECS=0
  CODEGEN_SETTLE_MAX_SECS=0
  CODEGEN_SETTLE_POLL_SECS=1
  GITHUB_TOKEN=
)

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
HEAVY_DIR=$(mktemp -d)

# ---------------------------------------------------------------------------
# Process cleanup (Port-Authority pattern).
#
# This suite spawns post-merge.sh subprocesses, which in turn may start
# background installs (`... pnpm install ... &`).  If this test run is killed
# or times out, those children would be orphaned and keep running, loading
# the machine and making later CI runs slow or nondeterministic.  The trap
# below kills the entire descendant tree on EXIT/TERM/INT: SIGTERM first,
# a short grace period, then SIGKILL survivors.
# ---------------------------------------------------------------------------
list_descendants() {
  # Echo all descendant PIDs of $1 (depth-first), excluding $1 itself.
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    list_descendants "$child"
    echo "$child"
  done
}

cleanup() {
  local ec=$?
  trap - EXIT TERM INT
  local pids
  pids=$(list_descendants $$)
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    # `sleep` is overridden to a no-op below; bypass the function.
    command sleep 1
    local survivors=""
    local p
    for p in $pids; do
      if kill -0 "$p" 2>/dev/null; then
        survivors="$survivors $p"
      fi
    done
    if [[ -n "$survivors" ]]; then
      echo "[test-post-merge] WARNING: force-killing surviving subprocesses:$survivors" >&2
      # shellcheck disable=SC2086
      kill -KILL $survivors 2>/dev/null || true
    fi
  fi
  rm -rf "$MOCK_DIR" "$HEAVY_DIR"
  # Port-guard synthetic test file: if the run is killed between creating it
  # and its inline `rm -f`, it would linger in artifacts/ and break the
  # check-hardcoded-ports.sh gate on every subsequent run.
  rm -f "$SCRIPT_DIR/../artifacts/".port-guard-test-*.ts
  exit "$ec"
}
trap cleanup EXIT TERM INT

# ---------------------------------------------------------------------------
# Heavy real checks run as background jobs launched up front.
#
# The five real quality-gate commands (parts-id typecheck, api-server
# typecheck, eslint, knip, env:check) dominate the wall-clock time of this
# suite when run serially (~50s).  They are independent of every mocked test,
# so we launch them all here and only collect their results at the original
# test positions below.  Each job writes <name>.out and <name>.exit into
# HEAVY_DIR; heavy_wait blocks (with a real sleep, bypassing the no-op mock)
# until the exit file appears.
#
# typecheck:libs runs ONCE in the foreground first (with the original 3-retry
# loop) so both typecheck jobs read stable compiled lib declarations and the
# two concurrent jobs never race each other inside tsc --build.
# ---------------------------------------------------------------------------
run_heavy() {
  local name="$1"; shift
  (
    local out exit_code
    out=$("$@" 2>&1); exit_code=$?
    printf '%s' "$out" > "$HEAVY_DIR/${name}.out"
    echo "$exit_code" > "$HEAVY_DIR/${name}.exit"
  ) &
}

heavy_wait() {
  local name="$1"
  while [[ ! -f "$HEAVY_DIR/${name}.exit" ]]; do command sleep 0.2; done
  HEAVY_OUTPUT=$(cat "$HEAVY_DIR/${name}.out")
  HEAVY_EXIT=$(cat "$HEAVY_DIR/${name}.exit")
}

# eslint, knip and env:check do not read the compiled lib declarations, so
# they can start before typecheck:libs completes — overlapping their runtime
# with the foreground lib build below.
run_heavy api_eslint      bash -c 'cd "$1/../artifacts/api-server" && pnpm exec eslint . --ext .ts' _ "$SCRIPT_DIR"
run_heavy api_knip        pnpm --filter @workspace/api-server dead-exports
run_heavy env_check       pnpm --filter @workspace/scripts env:check

# Build workspace lib declarations once, with retries to survive a concurrent
# codegen:check run deleting src/generated/ mid-build (TS6307).
TYPECHECK_LIBS_EXIT=1
TYPECHECK_LIBS_OUTPUT=""
for _attempt in 1 2 3; do
  TYPECHECK_LIBS_OUTPUT=$(pnpm -w run typecheck:libs 2>&1)
  TYPECHECK_LIBS_EXIT=$?
  if [[ "$TYPECHECK_LIBS_EXIT" -eq 0 ]]; then
    break
  fi
  command sleep 2
done

# The typecheck jobs invoke tsc directly with the same flags as the package
# "typecheck" scripts, but skip the scripts' pre-steps (typecheck:libs and
# codegen:ensure) because this suite already ran typecheck:libs — which itself
# runs codegen:ensure — in the foreground above.  parts-id's pretypecheck
# (router-type generation + shim check) is still run since tsc depends on the
# generated router.d.ts being current.
#
# knip runs ONCE (api_knip): the api-server "lint" script is `eslint && knip`,
# so the eslint-only job plus the knip job together cover the combined lint
# gate without paying for a duplicate knip run.
run_heavy parts_typecheck bash -c 'cd "$1/../artifacts/parts-id" && node scripts/generate-router-types.mjs && node scripts/check-shim-compat-versions.mjs && pnpm exec tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile node_modules/.cache/typecheck.tsbuildinfo' _ "$SCRIPT_DIR"
run_heavy api_typecheck   bash -c 'cd "$1/../artifacts/api-server" && pnpm exec tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile node_modules/.cache/typecheck.tsbuildinfo && pnpm exec tsc -p tsconfig.test.json --noEmit --incremental --tsBuildInfoFile node_modules/.cache/typecheck-test.tsbuildinfo' _ "$SCRIPT_DIR"

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
if grep -qE 'api-spec (run codegen|exec orval)' "$SCRIPT_DIR/post-merge.sh"; then
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

  if [[ "$DEV_SCRIPT" == *'--port $PORT'* ]]; then
    pass "metro-port-guard — --port \$PORT present in parts-id dev script"
  else
    fail "metro-port-guard — --port \$PORT MISSING from parts-id dev script"
  fi

  if [[ "$DEV_SCRIPT" == *'CI=1'* || "$DEV_SCRIPT" == *'--non-interactive'* ]]; then
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
if grep -qP 'timeout\s+[0-9]+\s+.*pnpm install' "$SCRIPT_DIR/post-merge.sh"; then
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
if grep -qP 'pnpm install.*&\s*$' "$SCRIPT_DIR/post-merge.sh"; then
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

# Retry up to 3 times: under full CPU load from the concurrent heavy jobs a
# mock-binary fork/exec can transiently fail, making post-merge.sh take the
# "lockfile unchanged" branch.  A genuine regression fails all attempts.
for _attempt in 1 2 3; do
  INSTALL_BG_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
  INSTALL_BG_EXIT=$?
  if [[ "$INSTALL_BG_EXIT" -eq 0 && "$INSTALL_BG_OUTPUT" == *background* ]]; then
    break
  fi
  command sleep 0.5
done
rm -rf "$MOCK_BIN_DIR"

assert_exit     "install timeout — exits non-zero"         0 "$INSTALL_BG_EXIT"
assert_contains "install timeout — prints timeout message" "background" "$INSTALL_BG_OUTPUT"

# ---------------------------------------------------------------------------
# Test 11: verify-fts step is present in post-merge.sh
# Ensures the FTS index check is wired into the deploy flow and cannot
# be accidentally removed without the test suite catching it.
# ---------------------------------------------------------------------------
if grep -q 'verify-fts' "$SCRIPT_DIR/post-merge.sh"; then
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

SKIP_DB_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR2:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
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

SCHEMA_DB_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR3:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
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
# typecheck:libs ran once (with 3 retries) at the top of this suite before
# the background typecheck jobs were launched; assert its stored result here.
# The parts-id typecheck itself runs as a background job launched up front;
# heavy_wait collects its result.
# ---------------------------------------------------------------------------
assert_exit "typecheck:libs — workspace libraries tsc --build exits 0 (before parts-id check)" 0 "$TYPECHECK_LIBS_EXIT"
if [[ "$TYPECHECK_LIBS_EXIT" -ne 0 ]]; then
  echo "  typecheck:libs output (first 20 lines):"
  echo "$TYPECHECK_LIBS_OUTPUT" | head -20 | sed 's/^/    /'
fi
heavy_wait parts_typecheck
assert_exit "typecheck — parts-id tsc --noEmit exits 0" 0 "$HEAVY_EXIT"
if [[ "$HEAVY_EXIT" -ne 0 ]]; then
  echo "  typecheck output (first 20 lines):"
  echo "$HEAVY_OUTPUT" | head -20 | sed 's/^/    /'
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

CODEGEN_NO_DRIFT_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR16:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
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

CODEGEN_FAIL_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR17:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
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

INSTALL_FAIL_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR18:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
INSTALL_FAIL_EXIT=$?
rm -rf "$MOCK_BIN_DIR18"

assert_exit     "install fail — script exits 0 (warning, not abort)"          0 "$INSTALL_FAIL_EXIT"
assert_contains "install fail — WARNING message logged"                        "WARNING: background install exited" "$INSTALL_FAIL_OUTPUT"
assert_contains "install fail — proceeds to health check after install wait"   "health check" "$INSTALL_FAIL_OUTPUT"

# ---------------------------------------------------------------------------
# Test 19: env:check exits 0 — all server env vars are documented
#
# Runs check-env-vars.ts directly and asserts exit 0.  Any future env var
# added to server code without a matching .env.example entry will fail here,
# catching the omission at the health-gate before it reaches a reviewer.
# ---------------------------------------------------------------------------
heavy_wait env_check
assert_exit "env:check — exits 0 (all vars documented)" 0 "$HEAVY_EXIT"
if [[ "$HEAVY_EXIT" -ne 0 ]]; then
  echo "  env:check output:"
  echo "$HEAVY_OUTPUT" | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 20: api-server lint exits 0 — no import-sort or other lint errors
#
# The api-server "lint" script is `eslint . --ext .ts && knip`.  Because the
# two checks are joined with `&&`, a failing eslint step short-circuits before
# knip ever runs, so a green "lint" result on its own does NOT prove that the
# knip (unused exports/imports) portion passed.  This suite therefore runs
# eslint and knip as SEPARATE background jobs (knip runs exactly once) and
# asserts each independently; the combined lint gate passes iff both pass, so
# a knip config drift (e.g. a new entrypoint added without updating knip.json)
# is caught here at the health-gate before merge, not silently masked by the
# combined lint script.
# ---------------------------------------------------------------------------
heavy_wait api_eslint
ESLINT_EXIT=$HEAVY_EXIT
ESLINT_OUTPUT=$HEAVY_OUTPUT
heavy_wait api_knip
KNIP_EXIT=$HEAVY_EXIT
KNIP_OUTPUT=$HEAVY_OUTPUT

LINT_COMBINED_EXIT=0
if [[ "$ESLINT_EXIT" -ne 0 || "$KNIP_EXIT" -ne 0 ]]; then
  LINT_COMBINED_EXIT=1
fi
assert_exit "api-server lint — exits 0 (eslint + knip combined)" 0 "$LINT_COMBINED_EXIT"
if [[ "$ESLINT_EXIT" -ne 0 ]]; then
  echo "  eslint output (first 20 lines):"
  echo "$ESLINT_OUTPUT" | head -20 | sed 's/^/    /'
fi

assert_exit "api-server knip — exits 0 (no unused exports/imports; config not drifted)" 0 "$KNIP_EXIT"
if [[ "$KNIP_EXIT" -ne 0 ]]; then
  echo "  knip output (first 20 lines):"
  echo "$KNIP_OUTPUT" | head -20 | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 21: api-server typecheck exits 0 — full tsc, including test files
#
# Runs `pnpm --filter @workspace/api-server run typecheck`, which executes
# BOTH `tsc -p tsconfig.json --noEmit` (src) AND
# `tsc -p tsconfig.test.json --noEmit` (src + __tests__).  The test tsconfig
# is the ONLY config that includes __tests__/*.ts, so this is the guard that
# makes a type error in any api-server test file surface automatically at the
# health-gate rather than slipping through unnoticed until a developer runs
# the check manually.
#
# Workspace lib declarations were built once (with 3 retries) at the top of
# this suite before the background typecheck jobs were launched; assert the
# stored result here.  The api-server typecheck itself runs as a background
# job launched up front; heavy_wait collects its result.
# ---------------------------------------------------------------------------
assert_exit "typecheck:libs — workspace libraries tsc --build exits 0 (before api-server check)" 0 "$TYPECHECK_LIBS_EXIT"
if [[ "$TYPECHECK_LIBS_EXIT" -ne 0 ]]; then
  echo "  typecheck:libs output (first 20 lines):"
  echo "$TYPECHECK_LIBS_OUTPUT" | head -20 | sed 's/^/    /'
fi
heavy_wait api_typecheck
assert_exit "api-server typecheck — full tsc (incl. tsconfig.test.json) exits 0" 0 "$HEAVY_EXIT"
if [[ "$HEAVY_EXIT" -ne 0 ]]; then
  echo "  api-server typecheck output (first 20 lines):"
  echo "$HEAVY_OUTPUT" | head -20 | sed 's/^/    /'
fi

# ---------------------------------------------------------------------------
# Test 21: PORT unset — health check falls back to the HTTPS proxy URL
#
# The PORT branch at the top of post-merge.sh runs at source time.  Source the
# script in a clean subshell with PORT unset and REPLIT_DEV_DOMAIN set, then
# print the resulting HEALTH_URL.  Asserts that:
#   (a) the WARNING line about the missing PORT is printed, and
#   (b) the fallback HEALTH_URL contains the REPLIT_DEV_DOMAIN (proxy URL).
# This guards against a future change silently removing the fallback and
# breaking post-merge in environments where PORT is not exported.
# ---------------------------------------------------------------------------
PORT_UNSET_OUTPUT=$(env -u PORT REPLIT_DEV_DOMAIN="mock-domain.test" \
  bash -c 'source "'"$SCRIPT_DIR"'/post-merge.sh"; echo "HEALTH_URL=$HEALTH_URL"' 2>&1)

assert_contains "PORT unset — WARNING line printed" \
  "WARNING: PORT is not set" "$PORT_UNSET_OUTPUT"
assert_contains "PORT unset — fallback URL uses REPLIT_DEV_DOMAIN" \
  "HEALTH_URL=https://mock-domain.test/api/healthz" "$PORT_UNSET_OUTPUT"

# ---------------------------------------------------------------------------
# Test 22: PORT set — health check uses the localhost URL
#
# Source the script in a clean subshell with PORT set, then run
# check_api_health with a curl mock that records the URL it is called with.
# Asserts that:
#   (a) no WARNING line is printed (the localhost branch is taken), and
#   (b) curl is called with http://localhost:<PORT>/api/healthz.
# ---------------------------------------------------------------------------
PORT_SET_URL_FILE=$(mktemp)
PORT_SET_OUTPUT=$(env PORT=53421 REPLIT_DEV_DOMAIN="mock-domain.test" \
  URL_FILE="$PORT_SET_URL_FILE" bash -c '
    source "'"$SCRIPT_DIR"'/post-merge.sh"
    curl() { echo "$@" | grep -oE "https?://[^ ]+" >> "$URL_FILE"; echo "{\"status\":\"ok\"}"; }
    sleep() { :; }
    check_api_health "port-set-test"
  ' 2>&1)
PORT_SET_URL=$(cat "$PORT_SET_URL_FILE")
rm -f "$PORT_SET_URL_FILE"

assert_contains "PORT set — curl uses localhost URL with PORT" \
  "http://localhost:53421/api/healthz" "$PORT_SET_URL"
if [[ "$PORT_SET_OUTPUT" == *"WARNING: PORT is not set"* ]]; then
  fail "PORT set — no fallback WARNING should be printed"
else
  pass "PORT set — no fallback WARNING printed"
fi

# ---------------------------------------------------------------------------
# Test 23: wait_for_codegen_settle returns early once the server responds
#
# The file-backed curl mock returns a healthy body on the very first poll.
# wait_for_codegen_settle should return 0 and log the "settle complete"
# message after a single probe rather than waiting out the full window.
# ---------------------------------------------------------------------------
reset_mock '{"status":"ok"}'
SETTLE_OUTPUT=$(wait_for_codegen_settle 2>&1)
assert_exit     "settle early — returns 0"              0 $?
assert_contains "settle early — logs settle complete"  'codegen settle complete' "$SETTLE_OUTPUT"

SETTLE_POLLS=$(cat "$MOCK_DIR/count")
assert_exit     "settle early — stops after 1 probe"   1 "$SETTLE_POLLS"

# ---------------------------------------------------------------------------
# Test 24: wait_for_codegen_settle exhausts the window but still returns 0
#
# curl never returns a healthy body.  wait_for_codegen_settle must poll up to
# CODEGEN_SETTLE_MAX_SECS and then return 0 (best-effort pre-warm — the real
# gate is the check_api_health pass that follows), logging the elapsed message.
# ---------------------------------------------------------------------------
reset_mock "" "" "" "" "" "" "" "" "" "" "" ""
SETTLE_FAIL_OUTPUT=$(wait_for_codegen_settle 2>&1)
assert_exit     "settle exhausted — returns 0 (non-fatal)"  0 $?
assert_contains "settle exhausted — logs window elapsed"    'Settle window' "$SETTLE_FAIL_OUTPUT"

# Must poll more than once (the floor + at least one probe), proving it is a
# real poll loop and not a single fixed sleep.
SETTLE_FAIL_POLLS=$(cat "$MOCK_DIR/count")
if [[ "$SETTLE_FAIL_POLLS" -gt 1 ]]; then
  pass "settle exhausted — polls multiple times (${SETTLE_FAIL_POLLS} probes)"
else
  fail "settle exhausted — expected multiple probes, got ${SETTLE_FAIL_POLLS}"
fi

# ---------------------------------------------------------------------------
# Test 25: post-merge.sh no longer relies on a fixed codegen settle sleep
#
# Guards against a regression back to `sleep "$CODEGEN_SETTLE_SECS"`.  The
# settle step must call the poll-based wait_for_codegen_settle function.
# ---------------------------------------------------------------------------
# The definition line is `wait_for_codegen_settle() {`; a real invocation is a
# bare call.  Exclude the definition so a deleted call site cannot pass this.
SETTLE_CALL_LINE=$(grep -nE '^\s*wait_for_codegen_settle\s*$' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
if [[ -n "$SETTLE_CALL_LINE" ]]; then
  pass "settle — post-merge.sh invokes wait_for_codegen_settle (line ${SETTLE_CALL_LINE})"
else
  fail "settle — post-merge.sh must invoke wait_for_codegen_settle (bare call, not just define it)"
fi

# The invocation must sit after codegen and before the first health-check pass
# so the server is settled before the authoritative gate runs.
SETTLE_CODEGEN_LINE=$(grep -nE 'api-spec (run codegen|exec orval)' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
SETTLE_HEALTHCHECK_LINE=$(grep -nE '^\s*if check_api_health' "$SCRIPT_DIR/post-merge.sh" | head -1 | cut -d: -f1)
if [[ -n "$SETTLE_CALL_LINE" && -n "$SETTLE_CODEGEN_LINE" && -n "$SETTLE_HEALTHCHECK_LINE" \
      && "$SETTLE_CALL_LINE" -gt "$SETTLE_CODEGEN_LINE" && "$SETTLE_CALL_LINE" -lt "$SETTLE_HEALTHCHECK_LINE" ]]; then
  pass "settle — invocation runs after codegen and before first health check"
else
  fail "settle — invocation must be after codegen (${SETTLE_CODEGEN_LINE}) and before first check_api_health (${SETTLE_HEALTHCHECK_LINE}), got ${SETTLE_CALL_LINE}"
fi

if grep -qE 'sleep +"\$CODEGEN_SETTLE_SECS"' "$SCRIPT_DIR/post-merge.sh"; then
  fail "settle — post-merge.sh still uses the old fixed 'sleep \$CODEGEN_SETTLE_SECS'"
else
  pass "settle — old fixed 'sleep \$CODEGEN_SETTLE_SECS' removed"
fi

# Test 26: SVG viewBox sync check is wired into post-merge.sh
#
# Guards against the check being silently skipped.  post-merge.sh must:
#   (a) invoke the svgViewBoxApiSync Jest test (cannot be skipped by a
#       missing env var since EXPO_PUBLIC_API_BASE is always set explicitly)
#   (b) set EXPO_PUBLIC_API_BASE explicitly (so the test env-var guard fires)
#   (c) wrap the test with `timeout 30` (so a slow server boot cannot produce
#       a silent CI hang)
# ---------------------------------------------------------------------------
if grep -q 'svgViewBoxApiSync' "$SCRIPT_DIR/post-merge.sh"; then
  pass "viewbox-sync — svgViewBoxApiSync test invocation present in post-merge.sh"
else
  fail "viewbox-sync — svgViewBoxApiSync test invocation MISSING from post-merge.sh"
fi

if grep -q 'EXPO_PUBLIC_API_BASE' "$SCRIPT_DIR/post-merge.sh"; then
  pass "viewbox-sync — EXPO_PUBLIC_API_BASE is set in post-merge.sh (check cannot be silently skipped)"
else
  fail "viewbox-sync — EXPO_PUBLIC_API_BASE is not set in post-merge.sh; the check would be silently skipped"
fi

if grep -A 25 'run_viewbox_sync_check()' "$SCRIPT_DIR/post-merge.sh" | grep -qP 'timeout\s+[0-9]+'; then
  pass "viewbox-sync — run_viewbox_sync_check wraps the test with a timeout guard"
else
  fail "viewbox-sync — run_viewbox_sync_check must wrap the pnpm test call with 'timeout <N>' to prevent silent CI hang"
fi

# ---------------------------------------------------------------------------
# Test 27: run_viewbox_sync_check is invoked after a successful health check
#
# Spawns post-merge.sh with a mock pnpm that:
#   - records whether the parts-id test step was called with EXPO_PUBLIC_API_BASE set
#   - exits 0 for codegen:fix (emitting the expected "drift auto-committed" line)
#   - exits 0 for the viewBox sync test (simulating a PASS)
# Asserts:
#   (a) svgViewBoxApiSync was invoked
#   (b) EXPO_PUBLIC_API_BASE was non-empty at invocation time
#   (c) post-merge exits 0
#
# NOTE: result files live outside MOCK_BIN_DIR27 so rm -rf cannot delete them
# before the assertions run.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR27=$(mktemp -d)
VIEWBOX_RESULT_DIR27=$(mktemp -d)
VIEWBOX_CALLED_FILE27="$VIEWBOX_RESULT_DIR27/viewbox_called"
VIEWBOX_API_BASE_FILE27="$VIEWBOX_RESULT_DIR27/viewbox_api_base"

cat > "$MOCK_BIN_DIR27/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR27/git"

cat > "$MOCK_BIN_DIR27/pnpm" << MOCKEOF
#!/bin/bash
if echo "\$*" | grep -q 'svgViewBoxApiSync'; then
  touch "$VIEWBOX_CALLED_FILE27"
  printf '%s' "\${EXPO_PUBLIC_API_BASE:-}" > "$VIEWBOX_API_BASE_FILE27"
fi
echo "drift auto-committed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR27/pnpm"

cat > "$MOCK_BIN_DIR27/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR27/curl"

VIEWBOX_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR27:$PATH" PORT=8080 REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
VIEWBOX_EXIT=$?
rm -rf "$MOCK_BIN_DIR27"

assert_exit "viewbox-sync wired — post-merge exits 0 when viewBox check passes" 0 "$VIEWBOX_EXIT"

if [[ -f "$VIEWBOX_CALLED_FILE27" ]]; then
  pass "viewbox-sync wired — svgViewBoxApiSync test was invoked after successful health check"
else
  fail "viewbox-sync wired — svgViewBoxApiSync test was NOT invoked after successful health check"
  echo "  post-merge output (last 20 lines):"
  echo "$VIEWBOX_OUTPUT" | tail -20 | sed 's/^/    /'
fi

SAVED_API_BASE=""
[[ -f "$VIEWBOX_API_BASE_FILE27" ]] && SAVED_API_BASE=$(cat "$VIEWBOX_API_BASE_FILE27")
if [[ -n "$SAVED_API_BASE" ]]; then
  pass "viewbox-sync wired — EXPO_PUBLIC_API_BASE was set at invocation (${SAVED_API_BASE})"
else
  fail "viewbox-sync wired — EXPO_PUBLIC_API_BASE was empty or not recorded; check would be silently skipped"
fi
rm -rf "$VIEWBOX_RESULT_DIR27"

# ---------------------------------------------------------------------------
# Test 28: check_generated_files — returns 0 when both sentinel files exist
#
# Sources post-merge.sh so check_generated_files is in scope, then calls it
# against real sentinel files.  Both lib/api-zod/src/generated/api.ts and
# lib/api-client-react/src/generated/api.ts must be non-empty on a healthy
# checkout.  This test fails if codegen was never run or the sentinel paths
# have been renamed, giving a clear signal before any typecheck step.
# ---------------------------------------------------------------------------
SENTINELS_OUTPUT=$(env REPLIT_DEV_DOMAIN="mock-domain.test" bash -c '
  source "'"$SCRIPT_DIR"'/post-merge.sh"
  if check_generated_files; then
    echo "SENTINELS_OK"
  else
    echo "SENTINELS_MISSING"
  fi
' 2>&1)

if [[ "$SENTINELS_OUTPUT" == *"SENTINELS_OK"* ]]; then
  pass "check_generated_files — both sentinel files exist and are non-empty"
else
  fail "check_generated_files — one or more sentinel files are missing/empty (run codegen first)"
  echo "  output: $SENTINELS_OUTPUT"
fi

# ---------------------------------------------------------------------------
# Test 29: pre-flight warning — post-merge prints an interrupted-codegen
#          warning when a sentinel file is missing before codegen:fix runs
#
# Spawns post-merge.sh with:
#   - a mock that creates a temporary workspace where ONLY one sentinel file is
#     absent (simulating a crash after orval's clean step but before write)
#   - mock git: no lockfile or schema changes so those branches are skipped
#   - mock pnpm: exits 0 for codegen:fix (simulating a successful re-run)
#   - mock curl: healthy so the health check passes
#
# Verifies:
#   (a) the WARNING about interrupted codegen is logged
#   (b) post-merge still exits 0 (codegen:fix restored the files)
# ---------------------------------------------------------------------------
MOCK_BIN_DIR29=$(mktemp -d)
MOCK_WORKSPACE29=$(mktemp -d)

# Create the workspace directory tree with ONE sentinel missing.
mkdir -p "$MOCK_WORKSPACE29/lib/api-zod/src/generated"
mkdir -p "$MOCK_WORKSPACE29/lib/api-client-react/src/generated"
# api-zod sentinel exists and is non-empty.
echo "export const x = 1;" > "$MOCK_WORKSPACE29/lib/api-zod/src/generated/api.ts"
# api-client-react sentinel is MISSING — simulates interrupted codegen.

cat > "$MOCK_BIN_DIR29/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR29/git"

# pnpm: for codegen:fix, write the missing sentinel so the post-flight check
# passes, simulating a successful codegen re-run.
cat > "$MOCK_BIN_DIR29/pnpm" << MOCKEOF
#!/bin/bash
if echo "\$*" | grep -q 'codegen:fix'; then
  echo "export const x = 1;" > "$MOCK_WORKSPACE29/lib/api-client-react/src/generated/api.ts"
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR29/pnpm"

cat > "$MOCK_BIN_DIR29/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR29/curl"

PREFLIGHT_OUTPUT=$(
  env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR29:$PATH" \
  REPLIT_DEV_DOMAIN="mock-domain.test" \
  bash -c "cd '$MOCK_WORKSPACE29' && bash '$SCRIPT_DIR/post-merge.sh'" 2>&1
)
PREFLIGHT_EXIT=$?
rm -rf "$MOCK_BIN_DIR29" "$MOCK_WORKSPACE29"

assert_exit     "pre-flight warning — exits 0 after successful codegen:fix"           0 "$PREFLIGHT_EXIT"
assert_contains "pre-flight warning — prints interrupted codegen warning"              "interrupted mid-run" "$PREFLIGHT_OUTPUT"

# ---------------------------------------------------------------------------
# Test 30: post-flight assertion — post-merge exits 1 with a clear error when
#          generated files are still missing after codegen:fix completes
#
# Simulates the edge case where codegen:fix exits 0 but the sentinel files
# are still absent (e.g. the orval output layout changed and no longer emits
# the sentinel path).  post-merge must not silently succeed in this state —
# it must fail loudly so the operator knows to investigate.
#
# Spawns post-merge.sh with:
#   - mock pnpm: exits 0 for codegen:fix but does NOT create any sentinel files
#   - mock git/curl: neutral so those branches succeed normally
#   - workspace with NO sentinel files at all
# ---------------------------------------------------------------------------
MOCK_BIN_DIR30=$(mktemp -d)
MOCK_WORKSPACE30=$(mktemp -d)

mkdir -p "$MOCK_WORKSPACE30/lib/api-zod/src/generated"
mkdir -p "$MOCK_WORKSPACE30/lib/api-client-react/src/generated"
# Both sentinels absent — simulates a crash or config change.

cat > "$MOCK_BIN_DIR30/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR30/git"

cat > "$MOCK_BIN_DIR30/pnpm" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR30/pnpm"

cat > "$MOCK_BIN_DIR30/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR30/curl"

POSTFLIGHT_OUTPUT=$(
  env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR30:$PATH" \
  REPLIT_DEV_DOMAIN="mock-domain.test" \
  bash -c "cd '$MOCK_WORKSPACE30' && bash '$SCRIPT_DIR/post-merge.sh'" 2>&1
)
POSTFLIGHT_EXIT=$?
rm -rf "$MOCK_BIN_DIR30" "$MOCK_WORKSPACE30"

assert_exit     "post-flight assertion — exits 1 when sentinels still missing"        1 "$POSTFLIGHT_EXIT"
assert_contains "post-flight assertion — prints clear error about missing files"       "Generated files still missing after codegen:fix" "$POSTFLIGHT_OUTPUT"

# ---------------------------------------------------------------------------
# Test 31: run_viewbox_sync_check FAILURE path — post-merge exits non-zero and
#          prints the SVG_VIEWBOX_W/H mismatch error when the viewBox check fails
#
# Test 27 only covers the happy path (the check runs and EXPO_PUBLIC_API_BASE is
# set).  This test covers the failure path: when the svgViewBoxApiSync jest test
# exits non-zero (e.g. SVG_VIEWBOX_W/H in mapViewport.ts no longer matches the
# server viewBox), post-merge must fail loudly rather than swallowing the error.
#
# Spawns post-merge.sh with a mock pnpm that:
#   - exits 1 when invoked with svgViewBoxApiSync (simulating a viewBox mismatch)
#   - exits 0 (emitting "drift auto-committed") for codegen:fix and everything
#     else so the run reaches the viewBox check
# Asserts:
#   (a) post-merge exits non-zero (the failure propagates through set -e)
#   (b) the SVG_VIEWBOX_W/H mismatch error message is printed
#
# This guards against a regression where run_viewbox_sync_check swallows errors
# (e.g. returns 0 unconditionally), which would pass Test 27 but silently let a
# viewBox drift ship.
# ---------------------------------------------------------------------------
MOCK_BIN_DIR31=$(mktemp -d)

cat > "$MOCK_BIN_DIR31/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR31/git"

cat > "$MOCK_BIN_DIR31/pnpm" << 'MOCKEOF'
#!/bin/bash
if echo "$*" | grep -q 'svgViewBoxApiSync'; then
  # Simulate a viewBox mismatch — the jest test exits non-zero.
  echo "SVG viewBox mismatch"
  exit 1
fi
echo "drift auto-committed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR31/pnpm"

cat > "$MOCK_BIN_DIR31/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR31/curl"

VIEWBOX_FAIL_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR31:$PATH" PORT=8080 REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
VIEWBOX_FAIL_EXIT=$?
rm -rf "$MOCK_BIN_DIR31"

if [[ "$VIEWBOX_FAIL_EXIT" -ne 0 ]]; then
  pass "viewbox-sync failure — post-merge exits non-zero when viewBox check fails (exit ${VIEWBOX_FAIL_EXIT})"
else
  fail "viewbox-sync failure — post-merge exited 0 despite viewBox check failing; the error was swallowed"
  echo "  post-merge output (last 20 lines):"
  echo "$VIEWBOX_FAIL_OUTPUT" | tail -20 | sed 's/^/    /'
fi

assert_contains "viewbox-sync failure — prints SVG_VIEWBOX_W/H mismatch error" "SVG_VIEWBOX_W/H" "$VIEWBOX_FAIL_OUTPUT"

# ---------------------------------------------------------------------------
# Test 32: run_viewbox_sync_check TIMEOUT path — post-merge exits non-zero and
#          prints the timeout-specific message when the viewBox check times out
#
# Test 26 only asserts the timeout guard *text* is present in the script, and
# Test 31 covers the generic failure path (jest exits non-zero → the
# SVG_VIEWBOX_W/H mismatch message).  Neither proves the exit-124 (timeout)
# branch actually fails the merge with its distinct message.  A regression that
# treated exit 124 as success (returning 0) or folded it into the generic
# branch would leave a silent CI hang indistinguishable from a real viewBox
# mismatch, and both existing tests would still pass.
#
# Spawns post-merge.sh with a mock `timeout` that:
#   - exits 124 for the svgViewBoxApiSync jest call (simulating the guard firing
#     on a hung jest run, e.g. the API server is unreachable)
#   - exits 0 for every other timeout-wrapped call (codegen:fix, etc.) so the
#     run reaches the viewBox check
# Asserts:
#   (a) post-merge exits non-zero (the failure propagates through set -e)
#   (b) the timeout-specific message ("timed out after 30s") is printed
#   (c) the generic SVG_VIEWBOX_W/H mismatch message is NOT printed, so the two
#       failure modes remain distinguishable
# ---------------------------------------------------------------------------
MOCK_BIN_DIR32=$(mktemp -d)

cat > "$MOCK_BIN_DIR32/git" << 'MOCKEOF'
#!/bin/bash
echo "artifacts/parts-id/components/PartCard.tsx"
MOCKEOF
chmod +x "$MOCK_BIN_DIR32/git"

# timeout: return 124 (guard fired) for the viewBox jest call; exit 0 for every
# other timeout-wrapped step (codegen:fix, etc.) so the run reaches the check.
cat > "$MOCK_BIN_DIR32/timeout" << 'MOCKEOF'
#!/bin/bash
# Drop the duration argument, then inspect the wrapped command.
shift
if echo "$*" | grep -q 'svgViewBoxApiSync'; then
  # Simulate the `timeout 30` guard firing on a hung jest run.
  echo "jest run hung"
  exit 124
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR32/timeout"

# pnpm: exit 0 for any call not routed through timeout (e.g. verify-fts).
cat > "$MOCK_BIN_DIR32/pnpm" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR32/pnpm"

cat > "$MOCK_BIN_DIR32/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR32/curl"

VIEWBOX_TIMEOUT_OUTPUT=$(env "${FAST_SPAWN_ENV[@]}" PATH="$MOCK_BIN_DIR32:$PATH" PORT=8080 REPLIT_DEV_DOMAIN="mock-domain.test" bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
VIEWBOX_TIMEOUT_EXIT=$?
rm -rf "$MOCK_BIN_DIR32"

if [[ "$VIEWBOX_TIMEOUT_EXIT" -ne 0 ]]; then
  pass "viewbox-sync timeout — post-merge exits non-zero when viewBox check times out (exit ${VIEWBOX_TIMEOUT_EXIT})"
else
  fail "viewbox-sync timeout — post-merge exited 0 despite the viewBox check timing out; the timeout was swallowed"
  echo "  post-merge output (last 20 lines):"
  echo "$VIEWBOX_TIMEOUT_OUTPUT" | tail -20 | sed 's/^/    /'
fi

assert_contains "viewbox-sync timeout — prints timeout-specific message" "timed out after 30s" "$VIEWBOX_TIMEOUT_OUTPUT"

# The timeout path must remain distinct from the generic mismatch failure.
if [[ "$VIEWBOX_TIMEOUT_OUTPUT" == *'SVG_VIEWBOX_W/H'* ]]; then
  fail "viewbox-sync timeout — printed the generic SVG_VIEWBOX_W/H mismatch message; the timeout path must be distinct"
else
  pass "viewbox-sync timeout — did NOT print the generic mismatch message (timeout path is distinct)"
fi

# ---------------------------------------------------------------------------
# Test 33: port guard — check-hardcoded-ports.sh exits 1 when a violation
#          exists inside the scanned artifacts/ path
#
# This synthetic test proves the grep pattern is wired up end-to-end:
#   1. A temporary .ts file containing a `process.env.PORT || "3000"` literal
#      is written into artifacts/ (the actual scan target).
#   2. check-hardcoded-ports.sh is run; it must exit 1.
#   3. The temp file is always cleaned up via a trap.
#
# If the scan path in check-hardcoded-ports.sh is changed from `artifacts/`
# to something else (or removed), this test will fail immediately, making the
# regression visible before it ships.
# ---------------------------------------------------------------------------
PORT_GUARD_TMP=$(mktemp "$SCRIPT_DIR/../artifacts/.port-guard-test-XXXXXX.ts")
printf 'const port = process.env.PORT || "3000";\n' > "$PORT_GUARD_TMP"

PORT_GUARD_OUTPUT=$(bash "$SCRIPT_DIR/check-hardcoded-ports.sh" 2>&1)
PORT_GUARD_EXIT=$?

rm -f "$PORT_GUARD_TMP"

assert_exit     "port-guard synthetic — exits 1 when violation in artifacts/"  1 "$PORT_GUARD_EXIT"
assert_contains "port-guard synthetic — prints ERROR header"                   "ERROR: Hardcoded port fallback" "$PORT_GUARD_OUTPUT"

# ---------------------------------------------------------------------------
# Test 34: security-audit is wired into the required CI gate
#
# Verifies two structural invariants in .replit:
#   (a) A workflow named "security-audit" exists AND carries isValidation=true,
#       proving it is a recognised quality gate and not just an ad-hoc script.
#   (b) The "Project" workflow (the runButton CI gate) lists "security-audit"
#       as one of its tasks, proving a future vulnerable lockfile entry will
#       fail the build automatically on every merge rather than only when the
#       workflow is run manually.
#
# Both checks read .replit directly and require no network access.  If either
# invariant breaks — e.g. someone removes security-audit from the Project task
# list, renames the workflow, or drops isValidation — this test fails before
# the change ships.
# ---------------------------------------------------------------------------
REPLIT_CFG="$SCRIPT_DIR/../.replit"

if grep -q 'name = "security-audit"' "$REPLIT_CFG"; then
  pass "security-audit — workflow declared in .replit"
else
  fail "security-audit — workflow NOT found in .replit (add a [[workflows.workflow]] block named 'security-audit')"
fi

# Check that the security-audit block carries isValidation = true.
# Strategy: extract the line number of 'name = "security-audit"' and then
# scan the following lines until the next [[workflows.workflow]] header,
# confirming isValidation appears in that window.
AUDIT_LINE=$(grep -n 'name = "security-audit"' "$REPLIT_CFG" | head -1 | cut -d: -f1)
NEXT_WORKFLOW_LINE=$(awk -v start="$AUDIT_LINE" 'NR > start && /^\[\[workflows\.workflow\]\]/ { print NR; exit }' "$REPLIT_CFG")
if [[ -z "$NEXT_WORKFLOW_LINE" ]]; then
  NEXT_WORKFLOW_LINE=$(wc -l < "$REPLIT_CFG")
fi

AUDIT_BLOCK=$(sed -n "${AUDIT_LINE},${NEXT_WORKFLOW_LINE}p" "$REPLIT_CFG")
if [[ "$AUDIT_BLOCK" == *'isValidation = true'* ]]; then
  pass "security-audit — isValidation = true set on the workflow"
else
  fail "security-audit — isValidation = true NOT found in the security-audit workflow block"
fi

# Check that the Project workflow lists security-audit as a task.
# The Project workflow tasks are the 'args = "..."' lines that appear between
# 'name = "Project"' and the next [[workflows.workflow]] header.
PROJECT_LINE=$(grep -n 'name = "Project"' "$REPLIT_CFG" | head -1 | cut -d: -f1)
NEXT_AFTER_PROJECT=$(awk -v start="$PROJECT_LINE" 'NR > start && /^\[\[workflows\.workflow\]\]/ { print NR; exit }' "$REPLIT_CFG")
if [[ -z "$NEXT_AFTER_PROJECT" ]]; then
  NEXT_AFTER_PROJECT=$(wc -l < "$REPLIT_CFG")
fi

PROJECT_BLOCK=$(sed -n "${PROJECT_LINE},${NEXT_AFTER_PROJECT}p" "$REPLIT_CFG")
if [[ "$PROJECT_BLOCK" == *'args = "security-audit"'* ]]; then
  pass "security-audit — listed as a task in the Project CI gate"
else
  fail "security-audit — NOT listed as a task in the Project CI gate (add a [[workflows.workflow.tasks]] entry with args = \"security-audit\")"
fi

# Check that the security-audit workflow command includes the prod moderate pass.
# This ensures the two-tier gate (high for all, moderate for prod-only) is intact.
if [[ "$AUDIT_BLOCK" == *'pnpm audit --prod --audit-level=moderate'* ]]; then
  pass "security-audit — prod moderate-level pass present in workflow command"
else
  fail "security-audit — prod moderate-level pass MISSING from security-audit workflow (add 'pnpm audit --prod --audit-level=moderate' to the command)"
fi

# ---------------------------------------------------------------------------
# Test 35: canvas-typecheck is wired into the required CI gate
#
# Verifies two structural invariants in .replit:
#   (a) A workflow named "canvas-typecheck" exists AND carries isValidation=true,
#       proving it is a recognised quality gate and not just an ad-hoc script.
#   (b) The "Project" workflow (the runButton CI gate) lists "canvas-typecheck"
#       as one of its tasks, proving that a future shadcn/ui scaffold update or
#       package bump that re-introduces type errors will fail the build
#       automatically on every merge rather than silently accumulating again.
#
# Background: recharts and input-otp changed their exported types after the
# shadcn/ui scaffold was generated; the 11 resulting TS errors were not caught
# until a manual audit because canvas-typecheck was not in the CI gate.
# ---------------------------------------------------------------------------
CANVAS_TC_LINE=$(grep -n 'name = "canvas-typecheck"' "$REPLIT_CFG" | head -1 | cut -d: -f1)
if [[ -n "$CANVAS_TC_LINE" ]]; then
  pass "canvas-typecheck — workflow declared in .replit"
else
  fail "canvas-typecheck — workflow NOT found in .replit (add a [[workflows.workflow]] block named 'canvas-typecheck')"
fi

if [[ -n "$CANVAS_TC_LINE" ]]; then
  NEXT_CANVAS_WORKFLOW_LINE=$(awk -v start="$CANVAS_TC_LINE" 'NR > start && /^\[\[workflows\.workflow\]\]/ { print NR; exit }' "$REPLIT_CFG")
  if [[ -z "$NEXT_CANVAS_WORKFLOW_LINE" ]]; then
    NEXT_CANVAS_WORKFLOW_LINE=$(wc -l < "$REPLIT_CFG")
  fi
  CANVAS_TC_BLOCK=$(sed -n "${CANVAS_TC_LINE},${NEXT_CANVAS_WORKFLOW_LINE}p" "$REPLIT_CFG")

  if [[ "$CANVAS_TC_BLOCK" == *'isValidation = true'* ]]; then
    pass "canvas-typecheck — isValidation = true set on the workflow"
  else
    fail "canvas-typecheck — isValidation = true NOT found in the canvas-typecheck workflow block"
  fi
fi

# Reuse PROJECT_BLOCK extracted in Test 34 (same variable, same scope).
if [[ "$PROJECT_BLOCK" == *'args = "canvas-typecheck"'* ]]; then
  pass "canvas-typecheck — listed as a task in the Project CI gate"
else
  fail "canvas-typecheck — NOT listed as a task in the Project CI gate (add a [[workflows.workflow.tasks]] entry with args = \"canvas-typecheck\")"
fi

# ---------------------------------------------------------------------------
# Test 36: process-cleanup traps are present (Port-Authority hygiene)
#
# Structural guards so the orphan-process cleanup cannot be silently removed:
#   (a) this test runner installs a cleanup trap on EXIT/TERM/INT that kills
#       its spawned descendant tree
#   (b) post-merge.sh installs a trap that terminates the background install
#       (INSTALL_PID) so an aborted run never leaves pnpm install running
# ---------------------------------------------------------------------------
SELF="$SCRIPT_DIR/test-post-merge.sh"

if grep -q 'trap cleanup EXIT TERM INT' "$SELF" && grep -q 'list_descendants' "$SELF"; then
  pass "cleanup-trap — test runner kills its descendant tree on EXIT/TERM/INT"
else
  fail "cleanup-trap — test runner is missing the EXIT/TERM/INT descendant-cleanup trap"
fi

if grep -q 'trap cleanup_background_install EXIT TERM INT' "$SCRIPT_DIR/post-merge.sh"; then
  pass "cleanup-trap — post-merge.sh cleans up background install on exit"
else
  fail "cleanup-trap — post-merge.sh is missing the background-install cleanup trap"
fi

# Behavioral check: an aborted post-merge.sh must not leave its background
# install running.  Mocks: git reports the lockfile changed (install branch
# taken), the mocked `timeout` starts a long-lived sleep for the install call
# but fails the codegen:fix call, so post-merge takes its early-abort exit-1
# path while the fake install is still running.  The EXIT trap must kill it.
MOCK_BIN_DIR36=$(mktemp -d)
BG_MARKER36="$MOCK_BIN_DIR36/bg_running"
# Distinctive duration so pgrep cannot match unrelated sleeps.
BG_SLEEP36="59.37"

# git: report lockfile changed so the background-install branch is taken.
cat > "$MOCK_BIN_DIR36/git" << 'MOCKEOF'
#!/bin/bash
echo "pnpm-lock.yaml"
MOCKEOF
chmod +x "$MOCK_BIN_DIR36/git"

# timeout: long-lived fake install for the `pnpm install` call; hard failure
# for codegen:fix so post-merge aborts (exit 1) while the install runs.
cat > "$MOCK_BIN_DIR36/timeout" << MOCKEOF
#!/bin/bash
shift
if echo "\$*" | grep -q 'install'; then
  touch "$BG_MARKER36"
  exec /bin/sleep $BG_SLEEP36
fi
exit 1
MOCKEOF
chmod +x "$MOCK_BIN_DIR36/timeout"

cat > "$MOCK_BIN_DIR36/pnpm" << 'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
chmod +x "$MOCK_BIN_DIR36/pnpm"

cat > "$MOCK_BIN_DIR36/curl" << 'MOCKEOF'
#!/bin/bash
echo '{"status":"ok"}'
MOCKEOF
chmod +x "$MOCK_BIN_DIR36/curl"

CLEANUP36_OUTPUT=$(PATH="$MOCK_BIN_DIR36:$PATH" REPLIT_DEV_DOMAIN="mock-domain.test" \
  bash "$SCRIPT_DIR/post-merge.sh" 2>&1)
CLEANUP36_EXIT=$?

assert_exit "cleanup-trap behavioral — post-merge aborts (exit 1) on codegen failure" 1 "$CLEANUP36_EXIT"

if [[ ! -f "$BG_MARKER36" ]]; then
  fail "cleanup-trap behavioral — background install never started (mock setup problem)"
else
  command sleep 1
  SURVIVOR36=$(pgrep -f "sleep $BG_SLEEP36" || true)
  if [[ -n "$SURVIVOR36" ]]; then
    fail "cleanup-trap behavioral — background install (PID $SURVIVOR36) survived post-merge abort"
    # shellcheck disable=SC2086
    kill -KILL $SURVIVOR36 2>/dev/null || true
  else
    pass "cleanup-trap behavioral — aborted post-merge.sh leaves no background install running"
  fi
fi

assert_contains "cleanup-trap behavioral — prints cleanup message" "Cleaning up background install" "$CLEANUP36_OUTPUT"
rm -rf "$MOCK_BIN_DIR36"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed."
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
