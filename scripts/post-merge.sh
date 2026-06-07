#!/bin/bash
set -e
CI=true pnpm install --frozen-lockfile
pnpm --filter db push --force

# Push latest main branch to GitHub after every successful merge.
# Uses || true so a network error never causes post-merge to report failure.
bash "$(dirname "$0")/sync-github.sh" || true

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
