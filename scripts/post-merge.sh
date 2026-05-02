#!/bin/bash
# Runs after every merged task. Keep this idempotent and non-interactive —
# stdin is closed, so any prompt will fail with EOF.
set -e

pnpm install --frozen-lockfile
pnpm --filter db push

# Refresh the auto-generated sections of the root README from artifact
# manifests, package.json scripts, and the curated features list. Idempotent.
pnpm --filter @workspace/scripts exec tsx ./src/update-readme.ts
