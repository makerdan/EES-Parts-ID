/**
 * Post-codegen hook: run after `orval` generates the api-client-react files.
 *
 * Ensures that `lib/api-client-react/src/index.ts` has one copy of each
 * generated export and always re-exports `./custom-fetch`. Newer Orval
 * versions append generated exports to an existing barrel, so simply checking
 * for the custom-fetch export can leave duplicate exports after regeneration.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const indexPath = resolve(
  __dirname,
  "..",
  "api-client-react",
  "src",
  "index.ts",
);

const CUSTOM_FETCH_EXPORT = 'export * from "./custom-fetch";';
const GENERATED_EXPORTS = [
  'export * from "./generated/api";',
  'export * from "./generated/api.schemas";',
];
const MANAGED_EXPORT = /^\s*export \* from ["']\.\/(?:custom-fetch|generated\/api(?:\.schemas)?|generated\/compatibility|compatibility)["'];\s*$/;

let contents = "";
try {
  contents = readFileSync(indexPath, "utf8");
} catch {
  // File doesn't exist yet — start from empty and let the export be added below.
}

const preservedLines = contents
  .split(/\r?\n/)
  .filter((line) => line.length > 0 && !MANAGED_EXPORT.test(line));
const normalized = [...preservedLines, CUSTOM_FETCH_EXPORT, ...GENERATED_EXPORTS].join("\n") + "\n";

if (normalized !== contents) {
  writeFileSync(indexPath, normalized, "utf8");
  console.log(`[post-codegen] Normalized generated exports in ${indexPath}`);
} else {
  console.log(`[post-codegen] Generated exports already normalized in ${indexPath}`);
}
