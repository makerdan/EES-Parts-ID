/**
 * Post-codegen hook: run after `orval` generates the api-client-react files.
 *
 * Ensures that `lib/api-client-react/src/index.ts` always re-exports
 * `./custom-fetch`. Orval can overwrite or recreate the barrel index when the
 * config or generated file names change, and the custom-fetch export is not
 * produced by orval — this script acts as a safety net so it is never silently
 * lost.
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

let contents = "";
try {
  contents = readFileSync(indexPath, "utf8");
} catch {
  // File doesn't exist yet — start from empty and let the export be added below.
}

if (!contents.includes(CUSTOM_FETCH_EXPORT)) {
  const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  const updated = contents + separator + CUSTOM_FETCH_EXPORT + "\n";
  writeFileSync(indexPath, updated, "utf8");
  console.log(`[post-codegen] Added missing export to ${indexPath}`);
} else {
  console.log(`[post-codegen] custom-fetch export already present in index.ts`);
}
