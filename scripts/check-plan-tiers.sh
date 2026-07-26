#!/usr/bin/env bash
# check-plan-tiers.sh
#
# Runs check-plan-tier.sh on every plan file found under .local/tasks/*.md
# that declares a "## Validation tier" section.  Files that predate the
# tier requirement (no section at all) are skipped with a notice so the
# linter is strictly additive and never breaks on legacy plan files.
#
# Usage: bash scripts/check-plan-tiers.sh
#
# Plan files are gitignored, so this script is designed to be run during
# task execution — before bulkCreateProjectTasks — rather than in a typical
# CI step.  Registering it as a validation workflow (plan-tier-check) gives
# agents a single command to invoke automatically.
#
# Exit codes:
#   0 — all tiered plan files passed (or no tiered plan files exist)
#   1 — one or more tiered plan files failed the tier lint

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN_TIER_SCRIPT="$SCRIPT_DIR/check-plan-tier.sh"

if [[ ! -f "$PLAN_TIER_SCRIPT" ]]; then
  echo "ERROR: check-plan-tier.sh not found at $PLAN_TIER_SCRIPT"
  exit 1
fi

PLAN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.local/tasks"

# Collect plan files.
shopt -s nullglob
PLAN_FILES=("$PLAN_DIR"/*.md)
shopt -u nullglob

if [[ "${#PLAN_FILES[@]}" -eq 0 ]]; then
  echo "✓ No plan files found under .local/tasks/ — nothing to lint."
  exit 0
fi

# Separate files into tiered (have the section) and legacy (no section).
TIERED_FILES=()
LEGACY_COUNT=0

for plan_file in "${PLAN_FILES[@]}"; do
  if grep -q "^## Validation tier" "$plan_file" 2>/dev/null; then
    TIERED_FILES+=("$plan_file")
  else
    ((LEGACY_COUNT++)) || true
  fi
done

if [[ "$LEGACY_COUNT" -gt 0 ]]; then
  echo "  (skipping $LEGACY_COUNT legacy plan file(s) that predate the tier requirement)"
fi

if [[ "${#TIERED_FILES[@]}" -eq 0 ]]; then
  echo "✓ No tiered plan files found — nothing to lint."
  exit 0
fi

echo "Linting ${#TIERED_FILES[@]} tiered plan file(s) under .local/tasks/ ..."
echo ""

FAILURES=0
for plan_file in "${TIERED_FILES[@]}"; do
  if ! bash "$PLAN_TIER_SCRIPT" "$plan_file"; then
    ((FAILURES++)) || true
  fi
done

echo ""
if [[ "$FAILURES" -gt 0 ]]; then
  echo "✗ $FAILURES plan file(s) failed the tier lint."
  exit 1
fi

echo "✓ All tiered plan files passed the tier lint."
exit 0
