#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# API Server health check — confirm the server is up after every merge and
# automatically restart it if it is not responding.
#
# Worst-case timing budget (must fit within [postMerge] timeoutMs in .replit):
#   DB push (conditional):  90s + FTS check: 15s          = 105s
#   codegen:fix (timeout):                                 = 120s
#   codegen settle poll (max window, early-exit typical):  =  20s
#   GitHub sync:                                           =   5s
#   Health check pass 1:  6 × 2s curl + 5 × 4s sleep      =  32s
#   SVG viewBox sync check (timeout 30s, typical <2s):     =  30s
#   SIGTERM/SIGKILL wait:                                  =  10s
#   Health check pass 2:  6 × 2s curl + 5 × 4s sleep      =  32s
#   SVG viewBox sync check (post-restart, typical <2s):    =  30s
#   Total worst case:                                      = 379s
#   Recommended [postMerge] timeoutMs in .replit:          = 420000 (420s)
# ---------------------------------------------------------------------------

if [[ -n "${PORT:-}" ]]; then
  HEALTH_URL="http://localhost:${PORT}/api/healthz"
else
  echo "[post-merge] WARNING: PORT is not set — falling back to HTTPS proxy URL for health check."
  HEALTH_URL="https://${REPLIT_DEV_DOMAIN}/api/healthz"
fi
MAX_RETRIES=6
SLEEP_SECS=4

# Codegen settle window — see wait_for_codegen_settle below.
#   FLOOR : minimum pause so the file-watcher can notice the codegen writes and
#           *begin* reloading (polling immediately would see the still-up
#           pre-reload process and return before the reload even starts).
#   MAX   : upper bound on the settle window; on a slow container that takes
#           longer than the old fixed 4s to reload, we keep polling up to here.
#   POLL  : interval between health probes inside the settle window.
# All three are env-overridable so a notably slow container can widen the
# window without editing this script (e.g. CODEGEN_SETTLE_MAX_SECS=40).
CODEGEN_SETTLE_FLOOR_SECS="${CODEGEN_SETTLE_FLOOR_SECS:-2}"
CODEGEN_SETTLE_MAX_SECS="${CODEGEN_SETTLE_MAX_SECS:-20}"
CODEGEN_SETTLE_POLL_SECS="${CODEGEN_SETTLE_POLL_SECS:-2}"

# ---------------------------------------------------------------------------
# check_generated_files — detect a partial/missing codegen state left by a
# previously crashed task and emit a clear diagnostic before proceeding.
#
# Orval runs with `clean: true`, so it wipes the generated directories before
# writing.  If a task agent is killed between the wipe and the write the dirs
# are left empty (or missing key sentinel files).  Without this guard the
# failure surfaces as cryptic TypeScript import errors on the next run, with no
# indication that a codegen crash was the root cause.
#
# The function checks the two sentinel files that orval always produces:
#   lib/api-zod/src/generated/api.ts
#   lib/api-client-react/src/generated/api.ts
#
# Returns:
#   0 — both files exist and are non-empty (generated dirs are intact)
#   1 — one or more files are missing or empty (interrupted codegen detected)
#
# The caller decides what to do; post-merge uses this for:
#   • pre-flight: warn that codegen was interrupted before re-running it
#   • post-flight: assert that codegen has fixed the state, exit 1 if not
# ---------------------------------------------------------------------------
GENERATED_SENTINELS=(
  "lib/api-zod/src/generated/api.ts"
  "lib/api-client-react/src/generated/api.ts"
)

check_generated_files() {
  local missing=0
  for sentinel in "${GENERATED_SENTINELS[@]}"; do
    if [[ ! -s "$sentinel" ]]; then
      echo "[post-merge] MISSING or EMPTY generated file: ${sentinel}"
      missing=1
    fi
  done
  return "$missing"
}

check_api_health() {
  local label="$1"
  echo "[post-merge] Starting API health check ($label) — up to ${MAX_RETRIES} attempts..."
  for i in $(seq 1 "$MAX_RETRIES"); do
    echo "[post-merge] Health check attempt ${i}/${MAX_RETRIES}: GET ${HEALTH_URL}"
    BODY=$(curl -s --max-time 2 "$HEALTH_URL" 2>/dev/null || true)
    # Require both a successful response and the exact expected JSON body.
    if echo "$BODY" | grep -q '"status":"ok"'; then
      echo "[post-merge] API Server is healthy."
      return 0
    fi
    echo "[post-merge] Not healthy yet (body=${BODY:-<no response>})."
    # Skip sleeping after the last attempt to avoid adding unnecessary delay.
    if [ "$i" -lt "$MAX_RETRIES" ]; then
      sleep "$SLEEP_SECS"
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# wait_for_codegen_settle — replaces the old fixed 4s sleep after codegen.
#
# The dev server's file watcher reloads when codegen writes new generated
# files.  A fixed sleep is fragile: on a fast container it wastes time, and on
# a slow one (large codegen write, loaded container) the reload can still be
# in progress when the sleep ends, so the first health-check pass catches the
# server mid-reload, fails, and needlessly kills + restarts it.
#
# Instead we sleep a short floor (so the watcher has time to notice the writes
# and *begin* reloading) and then poll the health endpoint, returning as soon
# as the server responds — up to CODEGEN_SETTLE_MAX_SECS.  Fast containers
# proceed in ~2s; slow ones get the extra time they need before the real
# health check runs.  Always returns 0: this is a best-effort pre-warm, and
# the authoritative gate is the health-check pass that follows.
# ---------------------------------------------------------------------------
wait_for_codegen_settle() {
  echo "[post-merge] Settling ${CODEGEN_SETTLE_FLOOR_SECS}s so the file-watcher can begin reloading after codegen..."
  sleep "$CODEGEN_SETTLE_FLOOR_SECS"

  local waited="$CODEGEN_SETTLE_FLOOR_SECS"
  while [ "$waited" -lt "$CODEGEN_SETTLE_MAX_SECS" ]; do
    local body
    body=$(curl -s --max-time 2 "$HEALTH_URL" 2>/dev/null || true)
    if echo "$body" | grep -q '"status":"ok"'; then
      echo "[post-merge] API Server responsive after ~${waited}s — codegen settle complete."
      return 0
    fi
    sleep "$CODEGEN_SETTLE_POLL_SECS"
    waited=$((waited + CODEGEN_SETTLE_POLL_SECS))
  done
  echo "[post-merge] Settle window (${CODEGEN_SETTLE_MAX_SECS}s) elapsed without a healthy response — proceeding to health check anyway."
  return 0
}

# ---------------------------------------------------------------------------
# run_viewbox_sync_check — run the SVG viewBox sync Jest test against the
# live local API server, with EXPO_PUBLIC_API_BASE set explicitly so the
# check can never be silently skipped by a missing env var.
#
# Wraps the Jest invocation in `timeout 30` so a slow server boot cannot
# produce a silent CI hang.  A 404 response (no floor plan uploaded yet) is
# treated as a skip by the test itself; any other non-zero exit is a hard
# failure that prints a fix hint before propagating the error.
# ---------------------------------------------------------------------------
run_viewbox_sync_check() {
  local api_base
  if [[ -n "${PORT:-}" ]]; then
    api_base="http://localhost:${PORT}/api"
  else
    api_base="https://${REPLIT_DEV_DOMAIN}/api"
  fi
  echo "[post-merge] Running SVG viewBox sync check (EXPO_PUBLIC_API_BASE=${api_base})..."
  local viewbox_output viewbox_exit
  viewbox_exit=0
  viewbox_output=$(EXPO_PUBLIC_API_BASE="$api_base" \
    timeout 30 pnpm --filter @workspace/parts-id exec jest \
      --testPathPattern=svgViewBoxApiSync --passWithNoTests 2>&1) || viewbox_exit=$?
  echo "$viewbox_output" | sed 's/^/[post-merge][viewbox-sync] /'
  if [[ "$viewbox_exit" -eq 124 ]]; then
    echo "[post-merge] ERROR: SVG viewBox sync check timed out after 30s — ensure the API server is reachable."
    return 1
  elif [[ "$viewbox_exit" -ne 0 ]]; then
    echo "[post-merge] ERROR: SVG viewBox sync check failed — SVG_VIEWBOX_W/H in mapViewport.ts may not match the server SVG."
    echo "[post-merge] Fix: update SVG_VIEWBOX_W / SVG_VIEWBOX_H in artifacts/parts-id/utils/mapViewport.ts to match the server viewBox, then rebuild (npx expo export -p web) and commit."
    return 1
  fi
  echo "[post-merge] SVG viewBox sync check passed."
}

# ---------------------------------------------------------------------------
# Main — only runs when the script is executed directly, not sourced.
# This guard allows test scripts to source and unit-test the functions above.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # Only run pnpm install if the lockfile changed in the merge.
  # Run in the background so it does not block the health check within the
  # 20s platform budget — the API server does not need a reinstall to stay
  # healthy, and packages are already on disk from the merge.
  if git --no-optional-locks diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q 'pnpm-lock.yaml'; then
    echo "[post-merge] Lockfile changed — installing dependencies in background..."
    timeout 120 sh -c 'CI=true pnpm install --frozen-lockfile' >> /tmp/post-merge-install.log 2>&1 &
    INSTALL_PID=$!
    echo "[post-merge] Install running in background (PID ${INSTALL_PID}). See /tmp/post-merge-install.log for output."
  else
    echo "[post-merge] Lockfile unchanged — skipping install."
  fi
  # Only run db push + FTS verification if schema files changed in the merge.
  # drizzle-kit push --force takes ~60s and the FTS index check takes ~15s even
  # with no changes; skipping both when the schema is untouched is critical for
  # staying within the 20s post-merge budget.
  if git --no-optional-locks diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q 'lib/db/src/schema'; then
    echo "[post-merge] Schema changed — running db push..."
    timeout 90 pnpm --filter db push --force || {
      DB_EXIT=$?
      if [[ "$DB_EXIT" -eq 124 ]]; then
        echo "[post-merge] ERROR: db push timed out after 90s. Aborting."
      else
        echo "[post-merge] ERROR: db push failed (exit ${DB_EXIT}). Aborting."
      fi
      exit 1
    }

    # Verify the FTS index after every schema push — a missing or drifted
    # inventory_fts_idx would silently break keyword search.
    echo "[post-merge] Verifying FTS index..."
    pnpm --filter @workspace/db run verify-fts || {
      echo "[post-merge] ERROR: FTS index check failed. Run 'pnpm --filter @workspace/db run push-force' to rebuild the index."
      exit 1
    }
    echo "[post-merge] FTS index OK."
  else
    echo "[post-merge] Schema unchanged — skipping db push and FTS check."
  fi

  # Pre-flight: detect a partial/missing codegen state left by a previously
  # crashed task agent.  Orval uses clean:true, so a mid-run crash wipes the
  # generated dirs and leaves them empty.  Without this check the downstream
  # failure (TypeScript import errors) has no obvious cause; naming the problem
  # here makes it immediately actionable.
  if ! check_generated_files; then
    echo "[post-merge] WARNING: One or more generated files are missing or empty — a previous codegen run appears to have been interrupted mid-run. Proceeding with codegen:fix to restore them."
  else
    echo "[post-merge] Pre-flight: generated files present."
  fi

  # Regenerate API client files and auto-commit any drift.
  # codegen:fix runs orval, rebuilds the lib declarations (tsc --build), then
  # commits any changes to the generated directories so a merge that carries a
  # stale generated file is fixed automatically rather than failing post-merge.
  # codegen:check (unchanged) is still used by CI/PR gates.
  #
  # git commit requires a user identity in the container; set it if missing.
  git config --global user.email "post-merge@replit.local" 2>/dev/null || true
  git config --global user.name "Post-Merge Bot" 2>/dev/null || true

  echo "[post-merge] Regenerating API client and auto-committing any drift..."
  timeout 120 pnpm --filter @workspace/api-spec run codegen:fix || {
    CODEGEN_EXIT=$?
    if [[ "$CODEGEN_EXIT" -eq 124 ]]; then
      echo "[post-merge] ERROR: codegen:fix timed out after 120s. Aborting."
    else
      echo "[post-merge] ERROR: codegen:fix failed (exit ${CODEGEN_EXIT}) — codegen or spec:check encountered an error."
    fi
    exit 1
  }
  echo "[post-merge] API client regenerated and any drift auto-committed."

  # Post-flight: assert that codegen:fix actually produced all sentinel files.
  # If codegen completed but a file is still missing (e.g. the orval output
  # config changed and no longer emits the sentinel), fail loudly here rather
  # than letting the API server crash on start with a cryptic import error.
  if ! check_generated_files; then
    echo "[post-merge] ERROR: Generated files still missing after codegen:fix — codegen may have completed with a different output layout or the orval config may have changed. Manual investigation required."
    exit 1
  fi

  # Give the API server's file watcher time to settle after codegen writes new
  # generated files.  Rather than a fixed sleep — which is either wasteful on a
  # fast container or too short on a slow one — poll the health endpoint and
  # proceed as soon as the server responds (up to a bounded max window).  This
  # prevents the first health-check pass from catching the server mid-reload.
  wait_for_codegen_settle

  # Push latest main branch to GitHub after every successful merge.
  # Uses || true so a network error never causes post-merge to report failure.
  bash "$(dirname "$0")/sync-github.sh" || true

  # Wait for background install to finish before health-checking the server.
  # A server that started before the install completed may crash due to missing
  # packages; waiting here avoids a spurious health-check failure and restart.
  if [ -n "${INSTALL_PID:-}" ]; then
    echo "[post-merge] Waiting for background install (PID ${INSTALL_PID}) to finish..."
    INSTALL_EXIT=0
    wait "$INSTALL_PID" || INSTALL_EXIT=$?
    if [ "$INSTALL_EXIT" -ne 0 ]; then
      echo "[post-merge] WARNING: background install exited with code ${INSTALL_EXIT} — see /tmp/post-merge-install.log. Proceeding to health check anyway."
    else
      echo "[post-merge] Background install completed successfully."
    fi
  fi

  # First health check pass.
  if check_api_health "initial"; then
    run_viewbox_sync_check
    exit 0
  fi

  # All retries failed — gracefully stop any stale process and let the
  # workflow supervisor restart it automatically.
  echo "[post-merge] API Server did not respond. Sending SIGTERM to stale process..."
  pkill -TERM -f "artifacts/api-server" 2>/dev/null || true

  # Poll until the process exits (up to ~10 seconds), then SIGKILL if needed.
  KILL_WAIT=0
  while kill -0 "$(pgrep -f 'artifacts/api-server' | head -1)" 2>/dev/null; do
    if [ "$KILL_WAIT" -ge 10 ]; then
      echo "[post-merge] Process did not exit after ${KILL_WAIT}s — sending SIGKILL."
      pkill -KILL -f "artifacts/api-server" 2>/dev/null || true
      break
    fi
    sleep 1
    KILL_WAIT=$((KILL_WAIT + 1))
  done
  echo "[post-merge] Stale process stopped. Workflow supervisor will restart the server."

  # Second health check pass after restart.
  if check_api_health "post-restart"; then
    run_viewbox_sync_check
    exit 0
  fi

  echo "[post-merge] ERROR: API Server is still not healthy after restart. Manual investigation required."
  exit 1
fi
