#!/usr/bin/env bash
# check-plan-tier.sh
#
# Lints a task plan markdown file to ensure it declares a valid validation tier.
#
# Usage: bash scripts/check-plan-tier.sh <path-to-plan-file>
#
# The plan file must contain a line:
#   ## Validation tier
#
# Followed (on the next non-blank line) by exactly one of:
#   fast
#   standard
#   standard-plus
#   heavy
#
# Exits 0 on success, 1 with a clear error on failure.
#
# This script is NOT wired into CI (plan files are gitignored). Task agents
# must run it on their plan file before calling bulkCreateProjectTasks.
# See replit.md § "Validation tier conventions" for the full convention.

set -euo pipefail

PLAN_FILE="${1:-}"

if [[ -z "$PLAN_FILE" ]]; then
  echo "Usage: bash scripts/check-plan-tier.sh <path-to-plan-file>"
  exit 1
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "ERROR: Plan file not found: $PLAN_FILE"
  exit 1
fi

VALID_TIERS=("fast" "standard" "standard-plus" "heavy")

# Find the line number of "## Validation tier"
tier_line=$(grep -n "^## Validation tier" "$PLAN_FILE" | head -1 | cut -d: -f1 || true)

if [[ -z "$tier_line" ]]; then
  echo ""
  echo "ERROR: Plan file is missing a '## Validation tier' section."
  echo ""
  echo "File: $PLAN_FILE"
  echo ""
  echo "Add a section like:"
  echo ""
  echo "  ## Validation tier"
  echo "  standard"
  echo ""
  echo "Valid tier names: fast, standard, standard-plus, heavy"
  echo ""
  echo "Guidelines (use these unless the plan clearly implies otherwise):"
  echo "  fast          — pure config/refactor with no logic change"
  echo "  standard      — most feature/bug-fix work; touching tests, mocks, or docs"
  echo "  standard-plus — DB schema, auth, or API contract changes"
  echo "  heavy         — same as standard-plus (currently identical steps)"
  echo ""
  exit 1
fi

# Find the next non-blank line after the ## Validation tier heading
total_lines=$(wc -l < "$PLAN_FILE")
declared_tier=""
check_line=$((tier_line + 1))

while [[ "$check_line" -le "$total_lines" ]]; do
  line_content=$(sed -n "${check_line}p" "$PLAN_FILE")
  # Skip blank lines
  if [[ -n "${line_content// /}" ]]; then
    declared_tier="$line_content"
    break
  fi
  check_line=$((check_line + 1))
done

# Strip leading/trailing whitespace
declared_tier="${declared_tier#"${declared_tier%%[![:space:]]*}"}"
declared_tier="${declared_tier%"${declared_tier##*[![:space:]]}"}"

if [[ -z "$declared_tier" ]]; then
  echo ""
  echo "ERROR: '## Validation tier' section is present but has no value."
  echo ""
  echo "File: $PLAN_FILE"
  echo ""
  echo "Add one of: fast, standard, standard-plus, heavy"
  echo "on the line immediately after the heading."
  echo ""
  exit 1
fi

# Validate against known tier names
valid=0
for t in "${VALID_TIERS[@]}"; do
  if [[ "$declared_tier" == "$t" ]]; then
    valid=1
    break
  fi
done

if [[ "$valid" -eq 0 ]]; then
  echo ""
  echo "ERROR: Invalid validation tier: '$declared_tier'"
  echo ""
  echo "File: $PLAN_FILE"
  echo ""
  echo "Valid tier names: fast, standard, standard-plus, heavy"
  echo ""
  exit 1
fi

echo "✓ Plan tier is valid: $declared_tier ($PLAN_FILE)"
