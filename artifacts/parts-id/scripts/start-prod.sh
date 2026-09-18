#!/usr/bin/env bash
# Production startup script.
# Starts the API server in the background, waits for it to be ready on port 8080,
# then starts the static file server in the foreground.
# Both processes share the same process group so Replit kills them together on shutdown.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_PORT="${API_SERVER_PORT:-$(node -e 'const fs=require("fs"); const path=require("path"); const p=path.join(process.argv[1],"scripts","dev-ports.json"); const r=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(String(r.NATIVE_API_DEV_PORT));' "$ROOT_DIR")}"
# Allow override via env var; default 90s covers migrations (~25s) + provider init (~8s)
# plus a comfortable margin for cold-container startup.
API_READY_TIMEOUT_SECS=${API_READY_TIMEOUT_SECS:-90}

echo "[start-prod] Starting API server on port ${API_PORT}..."
PORT=${API_PORT} pnpm --filter @workspace/api-server run start &
API_PID=$!

echo "[start-prod] Waiting up to ${API_READY_TIMEOUT_SECS}s for API server to be ready..."
ELAPSED=0
READY=0
while [ "${ELAPSED}" -lt "${API_READY_TIMEOUT_SECS}" ]; do
  if node -e "
    const net = require('net');
    const s = net.createConnection(${API_PORT}, 'localhost');
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => { s.destroy(); process.exit(1); });
  " 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "${API_PID}" 2>/dev/null; then
    echo "[start-prod] ERROR: API server process exited unexpectedly after ${ELAPSED}s." >&2
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ "${READY}" -eq 0 ]; then
  echo "[start-prod] ERROR: API server did not open port ${API_PORT} within ${API_READY_TIMEOUT_SECS}s." >&2
  kill "${API_PID}" 2>/dev/null || true
  exit 1
fi

echo "[start-prod] API server ready after ${ELAPSED}s. Starting static file server..."
export PORT
exec pnpm --filter @workspace/parts-id run serve
