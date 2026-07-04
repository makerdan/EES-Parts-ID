#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# API Server health check — confirm the server is up after every merge and
# automatically restart it if it is not responding.
#
# Timing per pass: 6 attempts × 2s curl timeout + 5 inter-attempt sleeps × 4s
# = 12s + 20s = 32s worst-case (~30s as specified).
# ---------------------------------------------------------------------------

if [[ -n "${PORT:-}" ]]; then
  HEALTH_URL="http://localhost:${PORT}/api/healthz"
else
  echo "[post-merge] WARNING: PORT is not set — falling back to HTTPS proxy URL for health check."
  HEALTH_URL="https://${REPLIT_DEV_DOMAIN}/api/healthz"
fi
MAX_RETRIES=6
SLEEP_SECS=4

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

  # Push latest main branch to GitHub after every successful merge.
  # Uses || true so a network error never causes post-merge to report failure.
  bash "$(dirname "$0")/sync-github.sh" || true

  # First health check pass.
  if check_api_health "initial"; then
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
    exit 0
  fi

  echo "[post-merge] ERROR: API Server is still not healthy after restart. Manual investigation required."
  exit 1
fi
