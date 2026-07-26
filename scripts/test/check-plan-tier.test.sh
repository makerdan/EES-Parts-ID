#!/usr/bin/env bash
# test/check-plan-tier.test.sh
#
# Inline bash tests for check-plan-tier.sh.
# Run with: bash scripts/test/check-plan-tier.test.sh
#
# Each test writes a temporary plan file, runs the script, and asserts the
# expected exit code and output.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/check-plan-tier.sh"
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

make_plan() {
  local file="$1"
  local tier="$2"
  local body="${3:-}"
  cat > "$file" <<EOF
# Test Plan

## Overview
$body

## Validation tier
$tier
EOF
}

assert_exit() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected exit $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected output to contain: $needle"
    echo "        actual output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_output_not_contains() {
  local label="$1"
  local needle="$2"
  local haystack="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected output NOT to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo ""
echo "=== check-plan-tier.sh tests ==="
echo ""

# --- 1. Valid tier, no risky keywords → clean pass ---
echo "Group: clean plans"
f="$TMPDIR_BASE/clean.md"
make_plan "$f" "standard" "Refactor the UI components."
out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
assert_exit "clean standard plan exits 0" 0 "$rc"
assert_output_contains "reports tier as valid" "✓ Plan tier is valid" "$out"
assert_output_not_contains "no warning emitted" "WARNING" "$out"
assert_output_not_contains "no error emitted" "ERROR" "$out"

# --- 2. Hard-fail keyword under 'fast' tier → exit 1 ---
echo ""
echo "Group: hard-fail keywords"

for kw in migration migrate drizzle; do
  f="$TMPDIR_BASE/hard-${kw}-fast.md"
  make_plan "$f" "fast" "Run a $kw step in the pipeline."
  out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
  assert_exit "hard-fail '$kw' under fast exits 1" 1 "$rc"
  assert_output_contains "'$kw' fast: error message present" "UNDER-TIER ERROR" "$out"
  assert_output_contains "'$kw' fast: matched word shown" "$kw" "$out"
done

for kw in migration migrate drizzle; do
  f="$TMPDIR_BASE/hard-${kw}-standard.md"
  make_plan "$f" "standard" "Run a $kw step in the pipeline."
  out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
  assert_exit "hard-fail '$kw' under standard exits 1" 1 "$rc"
  assert_output_contains "'$kw' standard: error message present" "UNDER-TIER ERROR" "$out"
done

# Hard-fail keywords at standard-plus → no error (tier is sufficient)
for kw in migration migrate drizzle; do
  f="$TMPDIR_BASE/hard-${kw}-stdplus.md"
  make_plan "$f" "standard-plus" "Run a $kw step in the pipeline."
  out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
  assert_exit "hard-fail '$kw' at standard-plus exits 0" 0 "$rc"
  assert_output_not_contains "'$kw' standard-plus: no error" "UNDER-TIER ERROR" "$out"
  assert_output_not_contains "'$kw' standard-plus: no warning" "WARNING" "$out"
done

# Hard-fail keywords at heavy → no error
for kw in migration migrate drizzle; do
  f="$TMPDIR_BASE/hard-${kw}-heavy.md"
  make_plan "$f" "heavy" "Run a $kw step in the pipeline."
  out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
  assert_exit "hard-fail '$kw' at heavy exits 0" 0 "$rc"
done

# --- 3. Soft-warn keywords under low tier → exit 0 with warning ---
echo ""
echo "Group: soft-warn keywords"

for kw in schema auth route contract security push; do
  f="$TMPDIR_BASE/soft-${kw}-standard.md"
  make_plan "$f" "standard" "Update $kw handling."
  out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
  assert_exit "soft-warn '$kw' under standard exits 0" 0 "$rc"
  assert_output_contains "'$kw' standard: warning emitted" "UNDER-TIER WARNING" "$out"
  assert_output_not_contains "'$kw' standard: no hard error" "UNDER-TIER ERROR" "$out"
done

# Soft-warn keywords at standard-plus → no warning
for kw in schema auth route contract security push; do
  f="$TMPDIR_BASE/soft-${kw}-stdplus.md"
  make_plan "$f" "standard-plus" "Update $kw handling."
  out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
  assert_exit "soft-warn '$kw' at standard-plus exits 0" 0 "$rc"
  assert_output_not_contains "'$kw' standard-plus: no warning" "WARNING" "$out"
done

# --- 4. Hard-fail keyword present but tier is standard-plus → no error ---
echo ""
echo "Group: sufficient tier suppresses all checks"

f="$TMPDIR_BASE/migration-stdplus.md"
make_plan "$f" "standard-plus" "Apply migration and drizzle push to the DB."
out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
assert_exit "migration+drizzle at standard-plus exits 0" 0 "$rc"
assert_output_not_contains "no error at standard-plus" "ERROR" "$out"
assert_output_not_contains "no warning at standard-plus" "WARNING" "$out"

# --- 5. Missing tier section → exit 1 ---
echo ""
echo "Group: malformed plans"

f="$TMPDIR_BASE/no-tier.md"
cat > "$f" <<EOF
# Plan without tier section
Some content here.
EOF
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "missing tier section exits 1" 1 "$rc"
assert_output_contains "missing tier: error message" "missing a '## Validation tier'" "$out"

f="$TMPDIR_BASE/invalid-tier.md"
make_plan "$f" "ultrafast" "Some content."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "invalid tier name exits 1" 1 "$rc"
assert_output_contains "invalid tier: error message" "Invalid validation tier" "$out"

# --- 6. Mixed: both hard-fail and soft-warn keywords → hard-fail wins ---
echo ""
echo "Group: mixed keywords"

f="$TMPDIR_BASE/mixed-fast.md"
make_plan "$f" "fast" "Run migration and update auth schema."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "mixed keywords under fast exits 1 (hard fail wins)" 1 "$rc"
assert_output_contains "mixed fast: hard error shown" "UNDER-TIER ERROR" "$out"
assert_output_not_contains "mixed fast: no soft warning" "UNDER-TIER WARNING" "$out"

# --- 7. File-path patterns: hard-fail even without migration/drizzle keywords ---
echo ""
echo "Group: file-path pattern hard-fail"

# lib/db/drizzle/ path under standard → exit 1
# Note: "drizzle" keyword fires first (it appears in the path itself), so the
# keyword error is shown rather than the path-pattern error. Both are correct
# hard-fails; we just verify exit 1 and the error message.
f="$TMPDIR_BASE/path-drizzle-dir-standard.md"
make_plan "$f" "standard" "Edit the file at lib/db/drizzle/schema.ts to add a column."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "lib/db/drizzle/ path under standard exits 1" 1 "$rc"
assert_output_contains "lib/db/drizzle/ standard: hard error shown" "UNDER-TIER ERROR" "$out"

# lib/db/drizzle/ path under fast → exit 1
f="$TMPDIR_BASE/path-drizzle-dir-fast.md"
make_plan "$f" "fast" "Edit the file at lib/db/drizzle/schema.ts to add a column."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "lib/db/drizzle/ path under fast exits 1" 1 "$rc"
assert_output_contains "lib/db/drizzle/ fast: hard error shown" "UNDER-TIER ERROR" "$out"

# lib/db/migrations/ path under standard → exit 1
# Note: "migration" keyword fires first (it appears in "migrations"), so the
# keyword error is shown rather than the path-pattern error.
f="$TMPDIR_BASE/path-migrations-dir-standard.md"
make_plan "$f" "standard" "Create lib/db/migrations/0012_add_index.sql."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit "lib/db/migrations/ path under standard exits 1" 1 "$rc"
assert_output_contains "lib/db/migrations/ standard: hard error shown" "UNDER-TIER ERROR" "$out"

# .sql file reference under standard → exit 1
f="$TMPDIR_BASE/path-sql-standard.md"
make_plan "$f" "standard" "Add a hand-written 0013_add_col.sql file to the repo."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit ".sql reference under standard exits 1" 1 "$rc"
assert_output_contains ".sql standard: hard error shown" "UNDER-TIER ERROR" "$out"
assert_output_contains ".sql standard: matched pattern shown" ".sql" "$out"

# .sql file reference under fast → exit 1
f="$TMPDIR_BASE/path-sql-fast.md"
make_plan "$f" "fast" "Add a hand-written 0013_add_col.sql file to the repo."
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit ".sql reference under fast exits 1" 1 "$rc"
assert_output_contains ".sql fast: hard error shown" "UNDER-TIER ERROR" "$out"

# File-path pattern at standard-plus → no error (tier is sufficient)
f="$TMPDIR_BASE/path-drizzle-dir-stdplus.md"
make_plan "$f" "standard-plus" "Edit the file at lib/db/drizzle/schema.ts to add a column."
out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
assert_exit "lib/db/drizzle/ at standard-plus exits 0" 0 "$rc"
assert_output_not_contains "lib/db/drizzle/ standard-plus: no error" "UNDER-TIER ERROR" "$out"
assert_output_not_contains "lib/db/drizzle/ standard-plus: no warning" "WARNING" "$out"

f="$TMPDIR_BASE/path-sql-stdplus.md"
make_plan "$f" "standard-plus" "Add a hand-written 0013_add_col.sql file to the repo."
out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
assert_exit ".sql at standard-plus exits 0" 0 "$rc"
assert_output_not_contains ".sql standard-plus: no error" "UNDER-TIER ERROR" "$out"

# File-path pattern at heavy → no error
f="$TMPDIR_BASE/path-drizzle-dir-heavy.md"
make_plan "$f" "heavy" "Edit the file at lib/db/drizzle/schema.ts to add a column."
out=$(bash "$SCRIPT" "$f" 2>&1); rc=$?
assert_exit "lib/db/drizzle/ at heavy exits 0" 0 "$rc"
assert_output_not_contains "lib/db/drizzle/ heavy: no error" "UNDER-TIER ERROR" "$out"

# File-path pattern without migration keyword: confirm keyword check alone would have missed it
f="$TMPDIR_BASE/path-sql-no-keyword.md"
make_plan "$f" "standard" "Update the ORM model and add 0014_rename_col.sql for the rename."
# This body has no 'migration'/'migrate'/'drizzle' keywords but does have .sql
out=$(bash "$SCRIPT" "$f" 2>&1) || rc=$?; rc=${rc:-0}
assert_exit ".sql no-keyword plan under standard exits 1" 1 "$rc"
assert_output_contains ".sql no-keyword: hard error shown" "UNDER-TIER ERROR" "$out"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
