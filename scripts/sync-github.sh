#!/usr/bin/env bash
# sync-github.sh — push main branch to makerdan/RDC34-Parts-ID
# Requires GITHUB_TOKEN secret (PAT with repo scope) to be set.
# Called manually or from post-merge.sh to keep GitHub in sync.
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN is not set. Add it in Replit Secrets." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GIT_BIN="$(command -v git)"
REMOTE="https://makerdan:${GITHUB_TOKEN}@github.com/makerdan/RDC34-Parts-ID.git"

echo "Syncing main branch to GitHub..."
"$GIT_BIN" -C "$REPO_ROOT" push "$REMOTE" main
echo "Done — https://github.com/makerdan/RDC34-Parts-ID"
