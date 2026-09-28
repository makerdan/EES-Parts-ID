#!/usr/bin/env bash
set -uo pipefail

# ── Serialization lock ────────────────────────────────────────────────────────
# The three suites share /tmp/jest-results-*.json output files and the
# manifest; concurrent invocations of this script would corrupt them and
# contend for CPU (making budgets lie). Re-exec ourselves under the
# crash-safe serial lock so concurrent runs queue instead of racing.
# The lock wrapper exports SERIAL_LOCK_HELD_PID and resource names. On the
# second pass (or when an ancestor already holds the shared-test-results or
# global resource) we fall through and run for real.
# IMPORTANT: everything below — including the outer watchdog budget — only
# starts AFTER the lock is acquired, so queue-wait time is never counted
# against any budget.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELD_RESOURCES=",${SERIAL_LOCK_HELD_RESOURCES:-},"
if [[ "$HELD_RESOURCES" != *,global,* && "$HELD_RESOURCES" != *,shared-test-results,* ]]; then
  exec node "${SCRIPT_DIR}/serial-lock.mjs" --resource shared-test-results --priority 2 -- bash "${BASH_SOURCE[0]}" "$@"
fi
echo "[test-all] serialized run — lock held (waited ${SERIAL_LOCK_WAIT_SECS:-0}s in queue; budgets start now)."

# ── Suite definitions: name:pnpm-filter:budget-seconds:runner ────────────────
# runner: jest | vitest
SUITES=(
  # Budget rationale: ~25-30s idle, but validation runs execute ~10 checks
  # (typechecks, lint, coverage, jest suites) concurrently and measured wall
  # time reached 90s+ under that contention (observed 90.16s overrun of the
  # old 90s budget). 180s is ~2× the loaded ceiling.
  "mockup-sandbox:./artifacts/mockup-sandbox:180:vitest"
  # Budget rationale: the full jest suite completes in ~70-120s on an idle
  # machine, but validation runs share CPU with three dev-server workflows and
  # measured wall time reached 150s+ under that load. 300s is ~2× the loaded
  # ceiling; a genuine hang still fails fast enough to be useful.
  "parts-id:./artifacts/parts-id:300:jest"
  # Budget rationale: ~60-90s idle, but observed >120s under validation-run
  # CPU contention (dev servers running concurrently). 240s is ~2× the loaded
  # ceiling. The old 600s budget was sized for DB-hang scenarios that no
  # longer apply.
  "api-server:./artifacts/api-server:240:jest"
)

# Total outer wall-clock cap (18 min).
TOTAL_BUDGET_SECONDS="${TEST_ALL_TOTAL_BUDGET_SECONDS:-1080}"
WATCHDOG_GRACE_SECONDS="${TEST_ALL_WATCHDOG_GRACE_SECONDS:-15}"

if ! [[ "$TOTAL_BUDGET_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[test-all] ERROR: TEST_ALL_TOTAL_BUDGET_SECONDS must be a positive integer." >&2
  exit 2
fi
if ! [[ "$WATCHDOG_GRACE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[test-all] ERROR: TEST_ALL_WATCHDOG_GRACE_SECONDS must be a positive integer." >&2
  exit 2
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
timestamp_ms() {
  date +%s%3N 2>/dev/null || echo "0"
}

# The watchdog records the currently running command so it can terminate only
# this harness's process tree. Killing process group 0 would also terminate an
# enclosing validation runner when this script is launched from one.
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/test-all-${BASHPID}.XXXXXX")"
RUN_ID="$(basename "$RUNTIME_DIR")"
RESULTS_DIR="${RUNTIME_DIR}/results"
JSON_DIR="$RESULTS_DIR"
MANIFEST_FILE="${RESULTS_DIR}/manifest.json"
TIMEOUT_MARKER="${RUNTIME_DIR}/timeout"
CURRENT_PID_FILE="${RUNTIME_DIR}/current-pid"
mkdir -p "$RESULTS_DIR"

process_tree_signal() {
  local pid="$1"
  local signal="$2"
  local child

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  while read -r child; do
    [[ -n "$child" ]] || continue
    process_tree_signal "$child" "$signal"
  done < <(ps -o pid= --ppid "$pid" 2>/dev/null)
  kill "-${signal}" "$pid" 2>/dev/null || true
}

# ── Outer watchdog ────────────────────────────────────────────────────────────
# Kill a stalled command after TOTAL_BUDGET_SECONDS using a background timer.
# Two-stage: SIGTERM first, then SIGKILL after WATCHDOG_GRACE_SECONDS if the
# process tree has not exited. The marker lets the parent return a stable,
# distinct timeout status after its wait completes.
(
  sleep "$TOTAL_BUDGET_SECONDS"
  printf 'outer wall-clock cap expired\n' > "$TIMEOUT_MARKER"
  echo ""
  echo "WARNING: Outer ${TOTAL_BUDGET_SECONDS}-second wall-clock cap reached — sending SIGTERM."
  current_pid="$(cat "$CURRENT_PID_FILE" 2>/dev/null || true)"
  process_tree_signal "$current_pid" TERM
  sleep "$WATCHDOG_GRACE_SECONDS"
  echo "WARNING: Process tree still alive after ${WATCHDOG_GRACE_SECONDS}s — sending SIGKILL."
  current_pid="$(cat "$CURRENT_PID_FILE" 2>/dev/null || true)"
  process_tree_signal "$current_pid" KILL
) &
WATCHDOG_PID=$!

# Clean up the watchdog whenever we exit normally.
cleanup_runtime() {
  process_tree_signal "$WATCHDOG_PID" TERM
  kill "$WATCHDOG_PID" 2>/dev/null || true
  rm -rf "$RUNTIME_DIR"
}
trap cleanup_runtime EXIT

run_owned() {
  local label="$1"
  shift
  "$@" &
  local child_pid=$!
  printf '%s\n' "$child_pid" > "$CURRENT_PID_FILE"

  local exit_code=0
  wait "$child_pid" || exit_code=$?

  rm -f "$CURRENT_PID_FILE"
  if [[ -f "$TIMEOUT_MARKER" ]]; then
    echo "[test-all] ERROR: outer wall-clock cap expired during ${label}; terminating the stalled process tree." >&2
    return 124
  fi
  return "$exit_code"
}

run_preflight_phase() {
  local phase="$1"
  shift

  local exit_code=0
  set +e
  run_owned "$phase" "$@"
  exit_code=$?
  set -e

  if [ "$exit_code" -eq 0 ]; then
    return 0
  fi

  local timed_out=false
  local status=FAILED
  if [ "$exit_code" -eq 124 ]; then
    timed_out=true
    status=TIMED_OUT
  fi

  # Keep setup failures fail-closed and machine-readable. Package suites have
  # not been entered when this helper runs, so the report must make that
  # evidence explicit rather than leaving consumers to infer it from missing
  # result files.
  if [[ -n "${VALIDATION_SETUP_REPORT_FILE:-}" ]]; then
    printf '%s\n' \
      "[test-all] PREFLIGHT_REPORT phase=\"${phase}\" status=${status} exit-status=${exit_code} timeout=${timed_out} suite-started=false child-status=${exit_code}" \
      > "$VALIDATION_SETUP_REPORT_FILE"
  fi
  echo "[test-all] PREFLIGHT_REPORT phase=\"${phase}\" status=${status} exit-status=${exit_code} timeout=${timed_out} suite-started=false child-status=${exit_code}" >&2
  echo "" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "  Validation Setup Summary" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  echo "  SETUP_${status}  ${phase}" >&2
  echo "    child-status=${exit_code}  timeout=${timed_out}  suite-started=false" >&2
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2
  if [ "$timed_out" = true ]; then
    exit 124
  fi
  echo "[test-all] ERROR: ${phase} failed (exit code ${exit_code})." >&2
  exit "$exit_code"
}

# Ensure generated API clients are present and current before any suite reads
# them. codegen:ensure is itself idempotent and file-locked (see
# lib/api-spec/scripts/ensure-codegen.mjs), so this cannot race a concurrent
# dev-workflow boot; running it here while we hold the serial lock also means
# no other test run can observe a mid-regeneration state.
run_preflight_phase \
  "codegen:ensure preflight" \
  pnpm --filter @workspace/api-spec run codegen:ensure

# Keep the API Jest wrapper's focused/full-run selection contract exercised by
# the canonical workspace test command.
run_preflight_phase \
  "API suite-floor preflight" \
  node scripts/test/api-suite-floor-contract.test.mjs

# ── Run suites ────────────────────────────────────────────────────────────────
declare -A RESULTS
declare -A WALL_CLOCKS

MANIFEST_ENTRIES=()

for entry in "${SUITES[@]}"; do
  IFS=: read -r name filter budget runner <<< "$entry"
  json_file="${JSON_DIR}/jest-results-${name}.json"
  json_staging_file="${JSON_DIR}/jest-results-${name}.json.staging"
  rm -f "$json_file" "$json_staging_file"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Running: $name  (budget: ${budget}s, runner: ${runner})"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Never let a prior invocation satisfy the report if this child exits
  # successfully without producing a fresh result artifact.
  rm -f "$json_file"
  start_ms=$(timestamp_ms)

  set +e
  # --kill-after=15s: if the runner doesn't exit after SIGTERM within 15s,
  # send SIGKILL to guarantee the process is forcibly terminated.
  if [ "$runner" = "vitest" ]; then
    # Vitest: pass flags directly to the binary so pnpm's arg pass-through
    # does not swallow --outputFile.  Also redirect stderr so JSON is clean.
    run_owned "suite ${name}" timeout --kill-after=15s "${budget}s" \
      pnpm --filter "$filter" exec vitest run \
        --reporter=json \
        --outputFile="${json_staging_file}" \
      2>&1
  else
    # Jest: standard --json --outputFile pass-through via pnpm run test
    run_owned "suite ${name}" timeout --kill-after=15s "${budget}s" \
      pnpm --filter "$filter" run test -- \
        --json \
        --outputFile="${json_staging_file}" \
      2>&1
  fi
  exit_code=$?
  # timeout --kill-after exits 124 for SIGTERM and 137 for SIGKILL;
  # treat both as TIMED_OUT.
  if [ "$exit_code" -eq 137 ]; then exit_code=124; fi
  set -e

  # Never let a runner's partial output become report evidence. The publisher
  # parses the staging file, stamps the current run ID, and renames it into
  # place atomically. Missing or invalid output remains absent so the report
  # can classify the suite as unavailable instead of treating it as passed.
  if [ -f "$json_staging_file" ]; then
    if ! node "${SCRIPT_DIR}/publish-test-result.mjs" \
      "$json_staging_file" "$json_file" "$RUN_ID" "$name"; then
      echo "[test-all] WARNING: could not publish result evidence for ${name}." >&2
    fi
  fi

  end_ms=$(timestamp_ms)
  wall_ms=$(( end_ms - start_ms ))

  if [ "$exit_code" -eq 124 ]; then
    RESULTS[$name]="TIMED_OUT"
  elif [ "$exit_code" -eq 0 ]; then
    RESULTS[$name]="PASSED"
  else
    RESULTS[$name]="FAILED"
  fi

  WALL_CLOCKS[$name]=$wall_ms

  budget_ms=$(( budget * 1000 ))
  MANIFEST_ENTRIES+=("{\"suite\":\"${name}\",\"runId\":\"${RUN_ID}\",\"jsonPath\":\"${json_file}\",\"startedAtMs\":${start_ms},\"wallClockMs\":${wall_ms},\"budgetMs\":${budget_ms},\"exitCode\":${exit_code}}")
done

# ── Write manifest ────────────────────────────────────────────────────────────
MANIFEST_TMP_FILE="${MANIFEST_FILE}.staging"
{
  printf '[\n'
  first=1
  for entry in "${MANIFEST_ENTRIES[@]}"; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ',\n'
    fi
    printf '%s' "$entry"
  done
  printf '\n]\n'
} > "$MANIFEST_TMP_FILE"
mv -f "$MANIFEST_TMP_FILE" "$MANIFEST_FILE"

# ── Suite summary ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test Suite Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

overall=0
for entry in "${SUITES[@]}"; do
  IFS=: read -r name filter budget runner <<< "$entry"
  result="${RESULTS[$name]:-UNKNOWN}"
  wall_ms="${WALL_CLOCKS[$name]:-0}"
  wall_s=$(( wall_ms / 1000 ))

  if [ "$result" = "PASSED" ]; then
    echo "  PASSED     $name  (${wall_s}s / budget ${budget}s)"
  elif [ "$result" = "TIMED_OUT" ]; then
    echo "  TIMED_OUT  $name  (${wall_s}s / budget ${budget}s)"
    overall=1
  else
    echo "  FAILED     $name  (${wall_s}s / budget ${budget}s)"
    overall=1
  fi
done
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Timeout report ────────────────────────────────────────────────────────────
echo "Generating timeout diagnostic report…"
echo ""
set +e
node scripts/test-timeout-report.mjs "$MANIFEST_FILE"
report_exit=$?
set -e

if [ "$report_exit" -ne 0 ]; then
  overall=1
fi

exit $overall
