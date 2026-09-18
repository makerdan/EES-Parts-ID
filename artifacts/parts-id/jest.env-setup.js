/**
 * Jest env bootstrap — runs before any module is imported (setupFiles).
 *
 * utils/apiBase.ts throws at module load when neither EXPO_PUBLIC_API_BASE
 * nor EXPO_PUBLIC_DOMAIN is set and __DEV__ is false (our jest global).
 * Dev shells usually inherit EXPO_PUBLIC_DOMAIN from the Expo workflow, but
 * validation runners and CI shells do not, which made two suites fail only
 * there. Default the variable here so the test environment is deterministic
 * regardless of shell environment. Tests that care about specific values
 * mock @/utils/apiBase explicitly and are unaffected.
 */
if (!process.env.EXPO_PUBLIC_API_BASE && !process.env.EXPO_PUBLIC_DOMAIN) {
  // Note: must NOT be http://localhost:8080 — apiBase.ts treats that exact
  // origin as "unconfigured dev fallback" and throws in non-dev builds.
  process.env.EXPO_PUBLIC_DOMAIN = "jest-tests.local";
}

