#!/usr/bin/env bash
set -uo pipefail

# ── Serialization lock ────────────────────────────────────────────────────────
# The three suites share /tmp/jest-results-*.json output files and the
# manifest; concurrent invocations of this script would corrupt them and
# contend for CPU (making budgets lie). Re-exec ourselves under the
# crash-safe serial lock so concurrent runs queue instead of racing.
# The lock wrapper exports SERIAL_LOCK_HELD_PID; on the second pass (or when
# an ancestor already holds the lock) we fall through and run for real.
# IMPORTANT: everything below — including the outer watchdog budget — only
# starts AFTER the lock is acquired, so queue-wait time is never counted
# against any budget.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${SERIAL_LOCK_HELD_PID:-}" ] || ! kill -0 "${SERIAL_LOCK_HELD_PID}" 2>/dev/null; then
  exec node "${SCRIPT_DIR}/serial-lock.mjs" -- bash "${BASH_SOURCE[0]}" "$@"
fi
echo "[test-all] serialized run — lock held (waited ${SERIAL_LOCK_WAIT_SECS:-0}s in queue; budgets start now)."

# Ensure generated API clients are present and current before any suite reads
# them. codegen:ensure is itself idempotent and file-locked (see
# lib/api-spec/scripts/ensure-codegen.mjs), so this cannot race a concurrent
# dev-workflow boot; running it here while we hold the serial lock also means
# no other test run can observe a mid-regeneration state.
pnpm --filter @workspace/api-spec run codegen:ensure || {
  echo "[test-all] ERROR: codegen:ensure failed — generated API clients may be missing."
  exit 1
}

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
TOTAL_BUDGET_SECONDS=1080

# Where Jest/Vitest JSON files land.
JSON_DIR="/tmp"

# Manifest written for the report script.
MANIFEST_FILE="/tmp/jest-run-manifest.json"

# ── Helpers ───────────────────────────────────────────────────────────────────
timestamp_ms() {
  date +%s%3N 2>/dev/null || echo "0"
}

# ── Outer watchdog ────────────────────────────────────────────────────────────
# Kill this entire script after TOTAL_BUDGET_SECONDS using a background timer.
# Two-stage: SIGTERM first, then SIGKILL after 15s if the process group hasn't exited.
(
  sleep "$TOTAL_BUDGET_SECONDS"
  echo ""
  echo "WARNING: Outer 18-minute wall-clock cap reached — sending SIGTERM."
  kill -TERM 0 2>/dev/null || true
  sleep 15
  echo "WARNING: Process group still alive after 15s — sending SIGKILL."
  kill -KILL 0 2>/dev/null || true
) &
WATCHDOG_PID=$!

# Clean up the watchdog whenever we exit normally.
trap 'kill "$WATCHDOG_PID" 2>/dev/null || true' EXIT

# ── Run suites ────────────────────────────────────────────────────────────────
declare -A RESULTS
declare -A WALL_CLOCKS

MANIFEST_ENTRIES=()

for entry in "${SUITES[@]}"; do
  IFS=: read -r name filter budget runner <<< "$entry"
  json_file="${JSON_DIR}/jest-results-${name}.json"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Running: $name  (budget: ${budget}s, runner: ${runner})"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  start_ms=$(timestamp_ms)

  set +e
  # --kill-after=15s: if the runner doesn't exit after SIGTERM within 15s,
  # send SIGKILL to guarantee the process is forcibly terminated.
  if [ "$runner" = "vitest" ]; then
    # Vitest: pass flags directly to the binary so pnpm's arg pass-through
    # does not swallow --outputFile.  Also redirect stderr so JSON is clean.
    timeout --kill-after=15s "${budget}s" \
      pnpm --filter "$filter" exec vitest run \
        --reporter=json \
        --outputFile="${json_file}" \
      2>&1
  else
    # Jest: standard --json --outputFile pass-through via pnpm run test
    timeout --kill-after=15s "${budget}s" \
      pnpm --filter "$filter" run test -- \
        --json \
        --outputFile="${json_file}" \
      2>&1
  fi
  exit_code=$?
  # timeout --kill-after exits 124 for SIGTERM and 137 for SIGKILL;
  # treat both as TIMED_OUT.
  if [ "$exit_code" -eq 137 ]; then exit_code=124; fi
  set -e

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
  MANIFEST_ENTRIES+=("{\"suite\":\"${name}\",\"jsonPath\":\"${json_file}\",\"wallClockMs\":${wall_ms},\"budgetMs\":${budget_ms},\"exitCode\":${exit_code}}")
done

# ── Write manifest ────────────────────────────────────────────────────────────
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
} > "$MANIFEST_FILE"

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
