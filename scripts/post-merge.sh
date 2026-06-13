#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# API Server health check — confirm the server is up after every merge and
# automatically restart it if it is not responding.
#
# Timing per pass: 6 attempts × 2s curl timeout + 5 inter-attempt sleeps × 4s
# = 12s + 20s = 32s worst-case (~30s as specified).
# ---------------------------------------------------------------------------

HEALTH_URL="https://${REPLIT_DEV_DOMAIN}/api/healthz"
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
  # On merges that only touch source files the lockfile is already satisfied,
  # and skipping install saves ~10s — critical for staying within the 20s budget.
  if git --no-optional-locks diff --name-only HEAD~1 HEAD 2>/dev/null | grep -q 'pnpm-lock.yaml'; then
    echo "[post-merge] Lockfile changed — installing dependencies..."
    timeout 120 sh -c 'CI=true pnpm install --frozen-lockfile' || {
      INSTALL_EXIT=$?
      if [[ "$INSTALL_EXIT" -eq 124 ]]; then
        echo "[post-merge] ERROR: pnpm install timed out after 120s. Aborting."
      else
        echo "[post-merge] ERROR: pnpm install failed (exit ${INSTALL_EXIT}). Aborting."
      fi
      exit 1
    }
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

  # Regenerate API client files so the Expo bundle never serves stale or missing
  # generated modules after a merge (orval cleans the output folder on every run).
  # We run orval directly (skipping the tsc --build that the full codegen script
  # appends) because the typecheck already passed before the merge and tsc --build
  # can take >20 s, which overruns the post-merge timeout budget.
  echo "[post-merge] Regenerating API client..."
  timeout 60 pnpm --filter @workspace/api-spec exec orval --config ./orval.config.ts || {
    CODEGEN_EXIT=$?
    if [[ "$CODEGEN_EXIT" -eq 124 ]]; then
      echo "[post-merge] ERROR: orval timed out after 60s. Aborting."
    else
      echo "[post-merge] ERROR: orval failed (exit ${CODEGEN_EXIT}). Aborting."
    fi
    exit 1
  }
  echo "[post-merge] API client regenerated."

  # Push latest main branch to GitHub after every successful merge.
  # Uses || true so a network error never causes post-merge to report failure.
  bash "$(dirname "$0")/sync-github.sh" || true

  # First health check pass.
  if check_api_health "initial"; then
    exit 0
  fi

  # All retries failed — kill any stale process and restart.
  echo "[post-merge] API Server did not respond. Killing stale process and restarting..."
  pkill -f "artifacts/api-server" 2>/dev/null || true
  sleep 2

  pnpm --filter @workspace/api-server dev &
  echo "[post-merge] API Server restarted in background (PID $!)."

  # Second health check pass after restart.
  if check_api_health "post-restart"; then
    exit 0
  fi

  echo "[post-merge] ERROR: API Server is still not healthy after restart. Manual investigation required."
  exit 1
fi
