#!/usr/bin/env bash
# Smoke test for scripts/pre-commit.sh.
#
# Each case writes a temporary TypeScript file containing a deliberate
# no-unused-vars violation, makes only that file appear staged through an
# isolated Git shim, and runs the real pre-commit hook. The package's real
# lint command must reject the violation, so a hook/package routing regression
# cannot pass silently.
#
# Usage: bash scripts/test-pre-commit.sh
# Exit:  0 if both package cases are rejected, 1 otherwise.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pre-commit-lint-test.XXXXXX")"
MOCK_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$MOCK_BIN_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

REAL_GIT="$(command -v git)"
cat > "$MOCK_BIN_DIR/git" <<MOCKEOF
#!/usr/bin/env bash
if [[ "\$1" == "diff" && "\$2" == "--cached" ]]; then
  printf '%s\n' "\${PRE_COMMIT_TEST_STAGED_PATH:?}"
  exit 0
fi
exec "$REAL_GIT" "\$@"
MOCKEOF
chmod +x "$MOCK_BIN_DIR/git"

PASS=0
FAIL=0

pass() {
  echo "PASS: $1"
  ((PASS++)) || true
}

fail() {
  echo "FAIL: $1"
  ((FAIL++)) || true
}

run_case() {
  local name="$1"
  local relative_fixture="$2"
  local fixture="$REPO_ROOT/$relative_fixture"
  local output
  local exit_code

  cat > "$fixture" <<'FIXTUREEOF'
/* eslint no-unused-vars: "error" */
const deliberatelyUnusedPreCommitProbe = 'this must fail lint';
FIXTUREEOF

  output=$(
    cd "$REPO_ROOT" &&
      PRE_COMMIT_TEST_STAGED_PATH="$relative_fixture" \
      PATH="$MOCK_BIN_DIR:$PATH" \
      sh scripts/pre-commit.sh
  ) 2>&1
  exit_code=$?
  rm -f "$fixture"

  if [[ "$exit_code" -eq 0 ]]; then
    fail "$name — hook rejects deliberate no-unused-vars violation"
    echo "$output" | sed 's/^/    /'
    return
  fi
  pass "$name — hook exits non-zero for deliberate no-unused-vars violation"

  if [[ "$output" == *"deliberatelyUnusedPreCommitProbe"* ]]; then
    pass "$name — failure comes from the deliberate unused variable"
  else
    fail "$name — output did not identify the deliberate unused variable"
    echo "$output" | sed 's/^/    /'
  fi
}

run_case "api-server" \
  "artifacts/api-server/src/__pre_commit_lint_probe.ts"
run_case "mockup-sandbox" \
  "artifacts/mockup-sandbox/src/__pre_commit_lint_probe.ts"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed."
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0