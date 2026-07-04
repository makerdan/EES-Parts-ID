#!/usr/bin/env tsx
/**
 * check-route-drift.ts
 *
 * Validates that Express route handlers only reference fields that are declared
 * in the OpenAPI spec (openapi.yaml). Catches drift — an undocumented field
 * used in a response or request body — before it reaches production.
 *
 * Response checks (object literals in res.json / res.status(...).json):
 *   Any explicit object key not in the spec's response schema is a violation.
 *   Object literals containing spread elements are noted but not rejected
 *   (we can't statically resolve spread shapes; they are flagged with a warning).
 *
 * Request-body checks (fields read from req.body):
 *   - `req.body as { field: T }` / `<{ field: T }>req.body` type assertions
 *   - `const { field } = req.body` destructuring
 *   - `req.body.field` / `req.body?.field` direct property access
 *
 * Routes NOT declared in the spec are skipped (internal admin endpoints are
 * intentionally undocumented).
 *
 * Exit 0: all clear
 * Exit 1: violations found (prints details)
 *
 * Usage:
 *   pnpm --filter @workspace/api-spec run spec:check
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import {
  buildSpecOperations,
  parsePrefixMap,
  analyzeFile,
  type OpenApiSpec,
  type Violation,
} from "./check-route-drift-helpers.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../../..");
const SPEC_PATH = resolve(ROOT, "lib/api-spec/openapi.yaml");
const ROUTES_INDEX = resolve(ROOT, "artifacts/api-server/src/routes/index.ts");
const ROUTES_DIR = resolve(ROOT, "artifacts/api-server/src/routes");

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const specYaml = readFileSync(SPEC_PATH, "utf-8");
  const spec = parseYaml(specYaml) as OpenApiSpec;
  const specOps = buildSpecOperations(spec);

  const prefixMap = parsePrefixMap(ROUTES_INDEX);

  const allViolations: Violation[] = [];
  for (const [filename, prefix] of prefixMap) {
    const filePath = resolve(ROUTES_DIR, filename);
    const violations = analyzeFile(filePath, prefix, specOps);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(
      "✅  spec:check passed — all route handlers conform to the OpenAPI spec.",
    );
    process.exit(0);
  }

  // Group violations by file for readable output
  const byFile = new Map<string, Violation[]>();
  for (const v of allViolations) {
    const list = byFile.get(v.file) ?? [];
    list.push(v);
    byFile.set(v.file, list);
  }

  console.error(
    "❌  spec:check FAILED — route handler(s) use undeclared fields:\n",
  );
  for (const [file, violations] of byFile) {
    const rel = file.replace(ROOT + "/", "");
    console.error(`  ${rel}`);
    for (const v of violations) {
      const suffix = v.note ? `  (${v.note})` : "";
      console.error(
        `    ${v.method} ${v.specPath}  [${v.kind}]  ` +
          `undeclared: ${v.undeclaredFields.join(", ")}${suffix}`,
      );
    }
    console.error("");
  }

  console.error(
    `  ${allViolations.length} violation(s) found.\n` +
      "  Either add the field(s) to openapi.yaml or remove them from the handler.\n",
  );
  process.exit(1);
}

main();
