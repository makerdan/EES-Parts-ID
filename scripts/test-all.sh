#!/usr/bin/env bash
set -euo pipefail

SUITES=(
  "parts-id:./artifacts/parts-id"
  "api-server:./artifacts/api-server"
  "mockup-sandbox:./artifacts/mockup-sandbox"
)

declare -A RESULTS

for entry in "${SUITES[@]}"; do
  name="${entry%%:*}"
  filter="${entry##*:}"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Running: $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if pnpm --filter "$filter" run test; then
    RESULTS[$name]="PASSED"
  else
    RESULTS[$name]="FAILED"
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test Suite Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

overall=0
for entry in "${SUITES[@]}"; do
  name="${entry%%:*}"
  result="${RESULTS[$name]}"
  if [ "$result" = "PASSED" ]; then
    echo "  ✓ $name: PASSED"
  else
    echo "  ✗ $name: FAILED"
    overall=1
  fi
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit $overall
