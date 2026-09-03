#!/usr/bin/env bash
# Production build script.
# Builds the API server (compiles TypeScript → dist/) and then
# builds the Expo web app (static-build/).
set -euo pipefail

echo "[build-prod] Building API server..."
pnpm --filter @workspace/api-server run build

echo "[build-prod] Building Expo web app..."
pnpm --filter @workspace/parts-id run build

echo "[build-prod] Done."
