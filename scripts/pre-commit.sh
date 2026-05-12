#!/bin/sh
# Pre-commit hook: verify that the codegen output is up-to-date with the
# OpenAPI source. Run manually to test: sh scripts/pre-commit.sh
pnpm codegen:check
