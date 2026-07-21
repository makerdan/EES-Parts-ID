#!/usr/bin/env bash
# Runs each api-server test suite in its own Jest process and reports suites
# whose process leaves async handles open (the "Jest did not exit one second
# after the test run has completed" warning). Used to hunt handle leaks; not
# part of the validation gates.
set -u
cd "$(dirname "$0")/.."
mkdir -p /tmp/handle-scan
FILES=$(ls __tests__/*.test.ts src/__tests__/*.test.ts)
run_one() {
  f="$1"
  out="/tmp/handle-scan/$(echo "$f" | tr '/' '_').log"
  if [ ! -s "$out" ] || ! grep -q "Tests:" "$out"; then
    timeout 180 npx jest --silent --runTestsByPath "$f" >"$out" 2>&1
  fi
  if grep -q "did not exit one second" "$out"; then
    echo "LEAK: $f"
  fi
}
export -f run_one
echo "$FILES" | xargs -P 6 -I{} bash -c 'run_one {}'
echo DONE
