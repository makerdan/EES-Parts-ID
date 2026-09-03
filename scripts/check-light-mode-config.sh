#!/usr/bin/env bash
# check-light-mode-config.sh — regression guard for the light-mode defaults.
#
# Checks three things:
#   1. app.json userInterfaceStyle must be "light" (never "automatic" or "dark").
#      Prevents the OS dark-mode preference from overriding the app's appearance
#      on native without an explicit user action.
#
#   2. DEFAULT_SETTINGS.themeMode in AppContext.tsx must be "light".
#      New installs (and users with no stored preference) must start in light mode.
#
#   3. No UI component or screen file outside hooks/ may import useColorScheme
#      directly from react-native.  Those files must go through useIsDark() or
#      useColors() from @/hooks/useColors so the user's explicit in-app setting
#      is respected instead of blindly following the OS dark-mode flag.
#      (Test files are exempt — they control isDark via mock injection.)
#
# Failure modes caught:
#   • Someone reverts app.json to "automatic" during a merge
#   • DEFAULT_SETTINGS drifts back to "system" or "dark"
#   • A future component reintroduces raw useColorScheme for isDark detection

set -euo pipefail
ERRORS=0

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_JSON="$ROOT_DIR/artifacts/parts-id/app.json"
APP_CONTEXT="$ROOT_DIR/artifacts/parts-id/contexts/AppContext.tsx"
COMPONENTS_DIR="$ROOT_DIR/artifacts/parts-id/components"
APP_DIR="$ROOT_DIR/artifacts/parts-id/app"

# ── 1. app.json userInterfaceStyle ────────────────────────────────────────────
UI_STYLE=$(node -e "process.stdout.write(require('$APP_JSON').expo.userInterfaceStyle)")
if [ "$UI_STYLE" != "light" ]; then
  echo "FAIL [1] app.json userInterfaceStyle is '$UI_STYLE' — must be 'light'" >&2
  echo "         This allows the OS dark-mode flag to override the app on native." >&2
  ERRORS=$((ERRORS + 1))
else
  echo "ok  [1] app.json userInterfaceStyle=light"
fi

# ── 2. DEFAULT_SETTINGS.themeMode ─────────────────────────────────────────────
if ! grep -qE 'themeMode:\s*"light"' "$APP_CONTEXT"; then
  echo "FAIL [2] DEFAULT_SETTINGS.themeMode is not \"light\" in AppContext.tsx" >&2
  echo "         New/unset users will inherit OS dark mode instead of starting light." >&2
  ERRORS=$((ERRORS + 1))
else
  echo "ok  [2] DEFAULT_SETTINGS.themeMode=\"light\" in AppContext.tsx"
fi

# ── 3. No raw useColorScheme in UI component/screen files ─────────────────────
# Allowed: hooks/ (that is where useIsDark lives), __tests__/ (mock injection).
# We check for files that BOTH contain "useColorScheme" AND import it from react-native.
RAW_FILES=()
while IFS= read -r -d '' file; do
  # Skip test files
  [[ "$file" == *"/__tests__/"* ]] && continue
  # Check it actually imports from react-native (not just mentions the string)
  if grep -qE "useColorScheme" "$file" && grep -qE "from ['\"]react-native['\"]" "$file"; then
    RAW_FILES+=("$file")
  fi
done < <(find "$COMPONENTS_DIR" "$APP_DIR" -name "*.ts" -o -name "*.tsx" -print0 2>/dev/null)

if [ ${#RAW_FILES[@]} -gt 0 ]; then
  echo "FAIL [3] raw useColorScheme import from react-native found in UI files:" >&2
  echo "         Use useIsDark() or useColors() from @/hooks/useColors instead" >&2
  echo "         so the user's in-app setting (not the OS flag) controls isDark." >&2
  for f in "${RAW_FILES[@]}"; do
    echo "         ${f#"$ROOT_DIR/"}" >&2
  done
  ERRORS=$((ERRORS + 1))
else
  echo "ok  [3] No raw useColorScheme in component/screen files"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -ne 0 ]; then
  echo "check-light-mode-config: $ERRORS check(s) FAILED." >&2
  exit 1
fi
echo "check-light-mode-config: all checks passed."
