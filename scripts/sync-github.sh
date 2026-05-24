#!/usr/bin/env bash
# sync-github.sh — push main branch to makerdan/RDC34-Parts-ID
# Requires GITHUB_TOKEN secret (PAT with repo scope) to be set.
# Called automatically from post-merge.sh after every task merge.
# Exits 0 even on failure so post-merge setup is never blocked by a sync error.

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "⚠️  GitHub sync skipped: GITHUB_TOKEN secret is not set."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_BIN="$(command -v git)"
REMOTE="https://makerdan:${GITHUB_TOKEN}@github.com/makerdan/RDC34-Parts-ID.git"

echo "Syncing main branch to GitHub..."
if "$GIT_BIN" -C "$REPO_ROOT" push "$REMOTE" main 2>&1 | sed "s|${GITHUB_TOKEN}|***|g"; then
  echo "✓ GitHub sync complete — https://github.com/makerdan/RDC34-Parts-ID"
else
  echo "⚠️  GitHub sync failed (non-fatal — post-merge continues normally)."
fi
