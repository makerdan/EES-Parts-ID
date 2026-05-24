#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push --force

# Push latest main branch to GitHub after every successful merge.
# Uses || true so a network error never causes post-merge to report failure.
bash "$(dirname "$0")/sync-github.sh" || true
