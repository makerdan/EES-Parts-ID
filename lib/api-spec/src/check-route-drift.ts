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
import { dirname,resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

import {
  analyzeFile,
  buildSpecOperations,
  checkHandcraftedZodTypes,
  checkSpecRouteCoverage,
  collectUnguardedJsonCalls,
  type OpenApiSpec,
  parsePrefixMap,
  type Violation,
} from "./check-route-drift-helpers.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../../..");
const SPEC_PATH = resolve(ROOT, "lib/api-spec/openapi.yaml");
const ROUTES_INDEX = resolve(ROOT, "artifacts/api-server/src/routes/index.ts");
const ROUTES_DIR = resolve(ROOT, "artifacts/api-server/src/routes");
const INVENTORY_ROUTES_PATH = resolve(ROOT, "lib/api-zod/src/inventoryRoutes.ts");

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const specYaml = readFileSync(SPEC_PATH, "utf-8");
  const spec = parseYaml(specYaml) as OpenApiSpec;
  const specOps = buildSpecOperations(spec);

  const prefixMap = parsePrefixMap(ROUTES_INDEX);

  const allViolations: Array<Violation> = [];
  for (const [filename, prefix] of prefixMap) {
    const filePath = resolve(ROUTES_DIR, filename);
    const violations = analyzeFile(filePath, prefix, specOps);
    allViolations.push(...violations);
    const unguardedViolations = collectUnguardedJsonCalls(filePath, prefix, specOps);
    allViolations.push(...unguardedViolations);
  }

  // Check reverse direction: spec paths that have no Express handler at all
  const coverageViolations = checkSpecRouteCoverage(specOps, prefixMap, ROUTES_DIR);
  allViolations.push(...coverageViolations);

  // Check hand-crafted Zod schemas for type drift vs the spec
  const inventoryRoutesSource = readFileSync(INVENTORY_ROUTES_PATH, "utf-8");
  const zodTypeViolations = checkHandcraftedZodTypes(
    spec,
    inventoryRoutesSource,
    INVENTORY_ROUTES_PATH,
  );
  allViolations.push(...zodTypeViolations);

  if (allViolations.length === 0) {
    console.log(
      "✅  spec:check passed — all route handlers conform to the OpenAPI spec.",
    );
    process.exit(0);
  }

  // Group violations by file for readable output
  const byFile = new Map<string, Array<Violation>>();
  for (const v of allViolations) {
    const list = byFile.get(v.file) ?? [];
    list.push(v);
    byFile.set(v.file, list);
  }

  console.error(
    "❌  spec:check FAILED — violations found:\n",
  );
  for (const [file, violations] of byFile) {
    const rel = file === "(spec)" ? "(spec — missing handlers)" : file.replace(ROOT + "/", "");
    console.error(`  ${rel}`);
    for (const v of violations) {
      if (v.kind === "missingHandler") {
        console.error(
          `    ${v.method} ${v.specPath}  [missingHandler]  spec path has no Express route handler`,
        );
      } else if (v.kind === "unguardedResponse") {
        const lineSuffix = v.line != null ? `:${v.line}` : "";
        console.error(
          `    ${v.method} ${v.specPath}  [unguardedResponse]  ${v.note ?? "res.json() argument is not the result of a Zod .parse() call"}${lineSuffix ? `  (line ${v.line})` : ""}`,
        );
      } else if (v.kind === "typeMismatch") {
        console.error(
          `    ${v.method}  [typeMismatch]  ${v.note ?? `field type mismatch: ${v.undeclaredFields.join(", ")}`}`,
        );
      } else {
        const suffix = v.note ? `  (${v.note})` : "";
        console.error(
          `    ${v.method} ${v.specPath}  [${v.kind}]  ` +
            `undeclared: ${v.undeclaredFields.join(", ")}${suffix}`,
        );
      }
    }
    console.error("");
  }

  console.error(
    `  ${allViolations.length} violation(s) found.\n` +
      "  Fix handler drift: add missing fields to openapi.yaml (or remove from handler).\n" +
      "  Fix missing handlers: add an Express route or remove the path from openapi.yaml.\n",
  );
  process.exit(1);
}

main();
