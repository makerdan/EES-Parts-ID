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

# ---------------------------------------------------------------------------
# Heuristic under-tier check
#
# Keywords are split into two groups:
#
#   HARD-FAIL keywords (migration, migrate, drizzle):
#     These represent the highest-risk operations. If any match and the tier
#     is below standard-plus, the script exits 1 with an actionable error.
#     schema-check, api-server-coverage, and post-merge-health-test do not
#     run below standard-plus, so silently under-tiering these plans is
#     dangerous.
#
#   SOFT-WARN keywords (schema, auth, route, contract, security, push):
#     These suggest elevated risk but may appear legitimately in lower-tier
#     plans (e.g. the word "schema" in a comment, or "route" in a UI task).
#     A warning is emitted but the script continues to exit 0.
# ---------------------------------------------------------------------------

HARD_FAIL_KEYWORDS="migration|migrate|drizzle"
# File-path patterns that indicate a DB migration even without explicit keywords.
# These are matched as fixed strings anywhere in the plan body.
HARD_FAIL_PATH_PATTERNS=(
  "lib/db/drizzle/"
  "lib/db/migrations/"
  ".sql"
)
SOFT_WARN_KEYWORDS="schema|auth|route|contract|security|push"
UNDER_TIER_TIERS=("fast" "standard")

is_under_tier=0
for t in "${UNDER_TIER_TIERS[@]}"; do
  if [[ "$declared_tier" == "$t" ]]; then
    is_under_tier=1
    break
  fi
done

if [[ "$is_under_tier" -eq 1 ]]; then
  # Check hard-fail keywords first.
  if grep -qiE "$HARD_FAIL_KEYWORDS" "$PLAN_FILE" 2>/dev/null; then
    matched=$(grep -oiE "$HARD_FAIL_KEYWORDS" "$PLAN_FILE" | sort -u | tr '\n' ' ')
    echo ""
    echo "✗  UNDER-TIER ERROR (hard fail)"
    echo ""
    echo "   Declared tier : $declared_tier"
    echo "   Matched words : $matched"
    echo "   File          : $PLAN_FILE"
    echo ""
    echo "   The plan body contains keywords that indicate a DB migration or"
    echo "   schema-push operation (migration, migrate, drizzle). These require"
    echo "   the 'standard-plus' tier so that schema-check, api-server-coverage,"
    echo "   and post-merge-health-test all run as part of validation."
    echo ""
    echo "   Update the tier to 'standard-plus' (or 'heavy') before calling"
    echo "   bulkCreateProjectTasks."
    echo ""
    exit 1
  fi

  # Check hard-fail file-path patterns (content-aware, keyword-independent).
  matched_path=""
  for pattern in "${HARD_FAIL_PATH_PATTERNS[@]}"; do
    if grep -qF "$pattern" "$PLAN_FILE" 2>/dev/null; then
      matched_path="$pattern"
      break
    fi
  done

  if [[ -n "$matched_path" ]]; then
    echo ""
    echo "✗  UNDER-TIER ERROR (hard fail)"
    echo ""
    echo "   Declared tier   : $declared_tier"
    echo "   Matched pattern : $matched_path"
    echo "   File            : $PLAN_FILE"
    echo ""
    echo "   The plan body references a file path that indicates a DB migration"
    echo "   or SQL schema change (e.g. lib/db/drizzle/, lib/db/migrations/,"
    echo "   or a .sql file). These require the 'standard-plus' tier so that"
    echo "   schema-check, api-server-coverage, and post-merge-health-test all"
    echo "   run as part of validation."
    echo ""
    echo "   Update the tier to 'standard-plus' (or 'heavy') before calling"
    echo "   bulkCreateProjectTasks."
    echo ""
    exit 1
  fi

  # Check soft-warn keywords (non-blocking).
  if grep -qiE "$SOFT_WARN_KEYWORDS" "$PLAN_FILE" 2>/dev/null; then
    matched=$(grep -oiE "$SOFT_WARN_KEYWORDS" "$PLAN_FILE" | sort -u | tr '\n' ' ')
    echo ""
    echo "⚠  UNDER-TIER WARNING"
    echo ""
    echo "   Declared tier : $declared_tier"
    echo "   Matched words : $matched"
    echo "   File          : $PLAN_FILE"
    echo ""
    echo "   The plan body contains keywords associated with DB schema changes,"
    echo "   authentication, or API contract work. These typically require the"
    echo "   'standard-plus' tier so that schema-check, api-server-coverage,"
    echo "   and post-merge-health-test run as part of validation."
    echo ""
    echo "   If this is intentional (e.g. the keywords appear only in comments"
    echo "   or the task genuinely requires no schema/auth/contract validation),"
    echo "   you can ignore this warning. Otherwise update the tier to"
    echo "   'standard-plus' before calling bulkCreateProjectTasks."
    echo ""
    echo "   This warning is non-blocking — the script exits 0."
    echo ""
  fi
fi
