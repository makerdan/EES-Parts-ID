/**
 * Regenerates `.expo/types/router.d.ts` using expo-router's own codegen.
 *
 * Expo Router normally regenerates this file during `expo start` / `expo export`,
 * but those commands aren't run before tests or typechecks.  Without automation
 * every newly-added screen requires a manual edit to router.d.ts — and if that
 * edit is forgotten, TypeScript rejects the route string at compile time and
 * crashes the entire Jest suite before a single test runs.
 *
 * This script delegates to the exact same internal function that expo-router uses
 * at runtime (`getTypedRoutesDeclarationFile`) so the output is byte-for-byte
 * identical to what `expo start` would produce — including support for dynamic
 * segments, catch-all routes, and route groups.
 *
 * Invoked by the `pretest` and `pretypecheck` npm hooks so the types are always
 * up-to-date before either entry-point executes.
 */

import { createRequire } from "module";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const APP_DIR = resolve(ROOT, "app");
const OUT_FILE = resolve(ROOT, ".expo", "types", "router.d.ts");

// Use the project's own copy of expo-router so the output is always consistent
// with the installed SDK version.
const req = createRequire(resolve(ROOT, "package.json"));

const { getTypedRoutesDeclarationFile } = req(
  "expo-router/build/typed-routes/generate"
);
const requireContext = req(
  "expo-router/build/testing-library/require-context-ponyfill"
).default;

// Build a require-context from the app/ directory — the same way expo-router
// does it internally when `EXPO_ROUTER_APP_ROOT` is set.
const ctx = requireContext(APP_DIR, /* scanSubDirectories */ true, /\.[tj]sx?$/);

const content = getTypedRoutesDeclarationFile(ctx);
if (!content) {
  console.error("generate-router-types: getTypedRoutesDeclarationFile returned null — no routes found?");
  process.exit(1);
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, content, "utf8");

const routeCount = (content.match(/pathname:/g) ?? []).length;
console.log(`router.d.ts regenerated via expo-router codegen (${routeCount} pathname entries)`);
