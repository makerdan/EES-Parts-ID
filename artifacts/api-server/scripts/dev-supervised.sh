#!/usr/bin/env bash
# Supervised dev runner: build once, then keep the node process alive.
# If the server crashes it restarts automatically after a short delay.
set -euo pipefail

export NODE_ENV=development

echo "[supervisor] Building..."
pnpm run build
echo "[supervisor] Build complete. Starting server (auto-restart on crash)..."

while true; do
  node --enable-source-maps ./dist/index.mjs || true
  echo "[supervisor] Server exited. Restarting in 3 s..."
  sleep 3
done
