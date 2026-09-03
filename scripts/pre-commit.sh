#!/bin/sh
# Pre-commit hook: run fast checks on staged files before commit.
# Run manually to test: sh scripts/pre-commit.sh

# 1. If any API-spec or generated-client files are staged, verify codegen
#    output is up-to-date with the OpenAPI source.
if git diff --cached --name-only | grep -qE \
  '^lib/api-spec/openapi\.yaml|^lib/api-client-react/src/generated/|^lib/api-zod/src/generated/'; then
  pnpm codegen:check
fi

# 2. Lint staged .ts/.tsx files to catch ESLint violations (e.g.
#    @typescript-eslint/no-unused-vars) before they reach the test-fast tier.
#
#    Strategy: if any staged files belong to a known package, run that
#    package's full lint step. This avoids per-file ESLint config-resolution
#    issues while keeping the hook scoped to only affected packages.
#
#    Smoke-test both package paths (without changing the Git index):
#      bash scripts/test-pre-commit.sh
#    The smoke test creates a temporary no-unused-vars violation in each
#    package and confirms this hook rejects it.

STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(ts|tsx)$' || true)

if [ -z "$STAGED" ]; then
  exit 0
fi

FAIL=0

# parts-id
if echo "$STAGED" | grep -q '^artifacts/parts-id/'; then
  echo "[pre-commit] Linting artifacts/parts-id..."
  pnpm --filter @workspace/parts-id run lint || FAIL=1
fi

# api-server
if echo "$STAGED" | grep -q '^artifacts/api-server/'; then
  echo "[pre-commit] Linting artifacts/api-server..."
  pnpm --filter @workspace/api-server run lint || FAIL=1
fi

# mockup-sandbox
if echo "$STAGED" | grep -q '^artifacts/mockup-sandbox/'; then
  echo "[pre-commit] Linting artifacts/mockup-sandbox..."
  pnpm --filter @workspace/mockup-sandbox run lint || FAIL=1
fi

# shared libs
if echo "$STAGED" | grep -q '^lib/'; then
  echo "[pre-commit] Linting lib/..."
  pnpm run lint:libs || FAIL=1
fi

exit $FAIL
