#!/bin/sh
# Pre-commit hook: if any API-spec or generated-client files are staged,
# verify that the codegen output is up-to-date with the OpenAPI source.
# Run manually to test: sh scripts/pre-commit.sh
if git diff --cached --name-only | grep -qE \
  '^lib/api-spec/openapi\.yaml|^lib/api-client-react/src/generated/|^lib/api-zod/src/generated/'; then
  pnpm codegen:check
fi
