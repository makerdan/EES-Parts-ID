#!/usr/bin/env bash
# check-env-leak.sh
#
# Guards against process.env mutations at module scope in test files that are
# never restored in an afterAll hook, which causes environment leaks across
# Jest workers and produces sporadic failures in unrelated suites.
#
# What it flags
# ─────────────
# Any line at column-0 (no leading whitespace) in a *.test.ts or *.test.tsx
# file that directly assigns a process.env variable:
#
#   process.env.VAR_NAME = "value"
#   process.env["VAR_NAME"] = "value"
#   process.env['VAR_NAME'] = "value"
#
# A module-scope assignment is only valid if the same file contains a
# `delete process.env.VAR_NAME` statement (the canonical afterAll restore
# pattern), ensuring the env is cleaned up after the suite finishes.
#
# What it does NOT flag
# ──────────────────────
# • Snapshot captures:  const _orig = process.env.VAR  (start with const/let)
# • In-function mutations: lines with leading whitespace (inside beforeAll,
#   beforeEach, describe callbacks, etc.)
# • Files with no module-scope assignments
#
# Required restore pattern
# ─────────────────────────
#   const _orig = process.env.VAR;
#   process.env.VAR = "test-value";            ← flagged if no afterAll delete
#
#   afterAll(() => {
#     if (_orig === undefined) delete process.env.VAR;   ← satisfies the check
#     else process.env.VAR = _orig;
#   });
#
# Remediation
# ────────────
# Save the original value before the assignment and restore it in afterAll:
#
#   const _origFoo = process.env.FOO;
#   process.env.FOO = "test-value";
#
#   afterAll(() => {
#     if (_origFoo === undefined) delete process.env.FOO;
#     else process.env.FOO = _origFoo;
#   });

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

VIOLATIONS=()

# Collect all test files under the project (excluding node_modules / dist).
mapfile -t TEST_FILES < <(find "$ROOT" \
  \( -name "*.test.ts" -o -name "*.test.tsx" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/static-build/*" \
  | sort)

for file in "${TEST_FILES[@]}"; do
  # Find every module-scope process.env assignment in this file.
  # grep -P "^process\.env" matches lines that start at column-0 with
  # "process.env" — only true module-scope (unindented) assignments.
  # We pipe through grep -v to exclude lines that are actually reads, e.g.:
  #   const _orig = process.env.VAR   (starts with "const", not "process")
  # Those are already excluded by the ^process\.env anchor; this comment is
  # just for clarity.
  while IFS= read -r assignment_line; do
    # ── Extract variable name ──────────────────────────────────────────────
    varname=""

    # Dot notation:  process.env.VAR_NAME =
    if [[ "$assignment_line" =~ ^process\.env\.([A-Za-z_][A-Za-z0-9_]*)\ *=\  ]]; then
      varname="${BASH_REMATCH[1]}"

    # Bracket double-quote notation: process.env["VAR_NAME"] =
    elif [[ "$assignment_line" =~ ^process\.env\[\"([A-Za-z_][A-Za-z0-9_]*)\"\]\ *=\  ]]; then
      varname="${BASH_REMATCH[1]}"

    # Bracket single-quote notation: process.env['VAR_NAME'] =
    elif [[ "$assignment_line" =~ ^process\.env\[\'([A-Za-z_][A-Za-z0-9_]*)\'\]\ *=\  ]]; then
      varname="${BASH_REMATCH[1]}"
    fi

    # Skip lines we couldn't parse (e.g. dynamic keys: process.env[someVar])
    [[ -z "$varname" ]] && continue

    # ── Check for a matching delete restore ────────────────────────────────
    # Accept any of:
    #   delete process.env.VAR_NAME
    #   delete process.env["VAR_NAME"]
    #   delete process.env['VAR_NAME']
    #   delete process.env[VAR_NAME]   (bare identifier — unusual but valid)
    #
    # Note: the afterAll re-assignment branch (process.env.VAR = _orig) is
    # always accompanied by the delete branch in a properly-written restore,
    # so checking for delete is both necessary and sufficient.
    if ! grep -qP "delete process\.env(\[[\"\']?${varname}[\"\']?\]|\.${varname}\b)" "$file" 2>/dev/null; then
      rel="${file#"$ROOT"/}"
      VIOLATIONS+=("$rel  →  process.env.${varname}")
    fi

  done < <(grep -P "^process\.env" "$file" 2>/dev/null || true)
done

# ── Report ─────────────────────────────────────────────────────────────────────

if [[ "${#VIOLATIONS[@]}" -gt 0 ]]; then
  echo ""
  echo "ERROR: Module-scope process.env mutation(s) without afterAll restore:"
  echo "----------------------------------------------------------------------"
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
  done
  echo "----------------------------------------------------------------------"
  echo ""
  echo "Each process.env variable set at module scope in a test file must be"
  echo "restored in an afterAll() hook to prevent environment leaks across"
  echo "Jest workers."
  echo ""
  echo "Fix:"
  echo "  const _origFOO = process.env.FOO;"
  echo "  process.env.FOO = 'test-value';"
  echo ""
  echo "  afterAll(() => {"
  echo "    if (_origFOO === undefined) delete process.env.FOO;"
  echo "    else process.env.FOO = _origFOO;"
  echo "  });"
  echo ""
  exit 1
fi

echo "✓ No unrestored module-scope process.env mutations found in test files."
