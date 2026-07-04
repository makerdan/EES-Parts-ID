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

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import ts from "typescript";

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "../../..");
const SPEC_PATH = resolve(ROOT, "lib/api-spec/openapi.yaml");
const ROUTES_INDEX = resolve(ROOT, "artifacts/api-server/src/routes/index.ts");
const ROUTES_DIR = resolve(ROOT, "artifacts/api-server/src/routes");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Keys always permitted in res.json() calls regardless of the spec because
 * they appear only in error branches (4xx / 5xx) that the spec intentionally
 * does not model with response schemas.
 */
const ALLOWED_ERROR_KEYS = new Set([
  "error",
  "message",
  "detail",
  "details",
  "job", // returned by background-job status endpoints
]);

// ── OpenAPI types ─────────────────────────────────────────────────────────────

interface OpenApiSpec {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface OperationObject {
  operationId?: string;
  requestBody?: {
    content?: { "application/json"?: { schema?: SchemaRef } };
  };
  responses?: Record<
    string,
    { content?: { "application/json"?: { schema?: SchemaRef } } }
  >;
}

type SchemaRef = { $ref: string } | SchemaObject;

interface SchemaObject {
  type?: string;
  properties?: Record<string, SchemaRef>;
  $ref?: string;
  items?: SchemaRef;
  required?: string[];
  allOf?: SchemaRef[];
  oneOf?: SchemaRef[];
  anyOf?: SchemaRef[];
  additionalProperties?: SchemaRef | boolean;
}

// ── Spec parsing ──────────────────────────────────────────────────────────────

function refName(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

/**
 * Recursively collect all property names from a schema, resolving $refs.
 * Depth-capped at 8 to handle self-referencing schemas (e.g. SearchResult.variants
 * contains InventoryItem which is also the top-level schema for other routes).
 */
function collectSchemaFields(
  schema: SchemaRef | undefined,
  allSchemas: Record<string, SchemaObject>,
  depth = 0,
): Set<string> {
  const fields = new Set<string>();
  if (!schema || depth > 8) return fields;

  if ("$ref" in schema && schema.$ref) {
    const resolved = allSchemas[refName(schema.$ref)];
    if (resolved) {
      collectSchemaFields(resolved, allSchemas, depth + 1).forEach((f) =>
        fields.add(f),
      );
    }
    return fields;
  }

  const s = schema as SchemaObject;
  if (s.properties) {
    Object.keys(s.properties).forEach((k) => fields.add(k));
  }
  for (const subList of [s.allOf, s.oneOf, s.anyOf]) {
    if (subList) {
      subList.forEach((sub) =>
        collectSchemaFields(sub, allSchemas, depth + 1).forEach((f) =>
          fields.add(f),
        ),
      );
    }
  }

  return fields;
}

/**
 * Build a map:  "METHOD /spec-path" → { requestFields, responseFields }
 * for every operation declared in the spec.
 */
function buildSpecOperations(spec: OpenApiSpec): Map<
  string,
  { requestFields: Set<string>; responseFields: Set<string> }
> {
  const schemas = spec.components?.schemas ?? {};
  const map = new Map<
    string,
    { requestFields: Set<string>; responseFields: Set<string> }
  >();

  for (const [specPath, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      const key = `${method.toUpperCase()} ${specPath}`;

      const reqBodySchema =
        op.requestBody?.content?.["application/json"]?.schema;
      const requestFields = collectSchemaFields(reqBodySchema, schemas);

      // Collect response fields only from 2xx responses (error responses are
      // not schema-modelled in this spec).
      const responseFields = new Set<string>();
      for (const [statusCode, response] of Object.entries(
        op.responses ?? {},
      )) {
        if (statusCode.startsWith("2")) {
          const respSchema =
            response.content?.["application/json"]?.schema;
          collectSchemaFields(respSchema, schemas).forEach((f) =>
            responseFields.add(f),
          );
        }
      }

      map.set(key, { requestFields, responseFields });
    }
  }

  return map;
}

// ── Route-index parsing ───────────────────────────────────────────────────────

/**
 * Parse routes/index.ts to build a filename → mount-prefix map.
 *
 * Handles:
 *   router.use(someRouter)            → prefix ""
 *   router.use("/prefix", someRouter) → prefix "/prefix"
 */
function parsePrefixMap(indexPath: string): Map<string, string> {
  const src = readFileSync(indexPath, "utf-8");
  const sf = ts.createSourceFile(
    indexPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // localName → "health.ts"
  const importNames = new Map<string, string>();
  ts.forEachChild(sf, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const modSpec = (node.moduleSpecifier as ts.StringLiteral).text;
    const defaultName = node.importClause?.name?.text;
    if (defaultName && modSpec.startsWith("./")) {
      importNames.set(defaultName, modSpec.slice(2) + ".ts");
    }
  });

  const prefixMap = new Map<string, string>();
  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "use"
    ) {
      const args = node.arguments;
      if (args.length === 1 && ts.isIdentifier(args[0])) {
        const fname = importNames.get(args[0].text);
        if (fname) prefixMap.set(fname, "");
      } else if (
        args.length >= 2 &&
        ts.isStringLiteral(args[0]) &&
        ts.isIdentifier(args[1])
      ) {
        const fname = importNames.get(args[1].text);
        if (fname) prefixMap.set(fname, args[0].text);
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  return prefixMap;
}

// ── AST helpers ───────────────────────────────────────────────────────────────

/** Returns true when expr is the identifier `res` or a chain rooted at `res`.
 *
 * Matches:
 *   res
 *   res.status(...)
 *   res.type("json").status(201)
 *   (void res.status(...)) — parenthesised forms
 */
function isResReceiver(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "res";
  if (ts.isParenthesizedExpression(expr)) return isResReceiver(expr.expression);
  if (ts.isCallExpression(expr)) return isResReceiver(expr.expression);
  if (ts.isPropertyAccessExpression(expr))
    return isResReceiver(expr.expression);
  return false;
}

/** True when the expression is `req.body` (or `req?.body`). */
function isReqBody(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "req" &&
      expr.name.text === "body"
    );
  }
  // Optional chaining: req?.body
  if (ts.isElementAccessExpression(expr)) return false;
  return false;
}

/**
 * Strip an AsExpression or TypeAssertionExpression wrapper to reach the inner
 * expression, recursively (e.g. `(req.body as A) as B` → `req.body`).
 */
function stripCast(expr: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expr)) return stripCast(expr.expression);
  if (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(expr))
    return stripCast(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return stripCast(expr.expression);
  return expr;
}

/** Extract string keys from an ObjectLiteralExpression (non-spread only). */
function objectLiteralKeys(node: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const prop of node.properties) {
    if (
      ts.isPropertyAssignment(prop) ||
      ts.isShorthandPropertyAssignment(prop)
    ) {
      const n = prop.name;
      if (ts.isIdentifier(n)) keys.push(n.text);
      else if (ts.isStringLiteral(n)) keys.push(n.text);
    }
    // SpreadAssignment: skip — shape is not statically knowable
  }
  return keys;

}

/** Extract property names from a TypeLiteralNode (`{ a: T; b: T }`). */
function typeLiteralFields(typeNode: ts.TypeNode): string[] {
  if (!ts.isTypeLiteralNode(typeNode)) return [];
  return typeNode.members
    .filter(ts.isPropertySignature)
    .flatMap((m) => {
      if (!m.name) return [];
      if (ts.isIdentifier(m.name)) return [m.name.text];
      if (ts.isStringLiteral(m.name)) return [m.name.text];
      return [];
    });
}

// ── res.json detection ────────────────────────────────────────────────────────

/**
 * Walk a res.status(...).type(...).json(...) chain and return the first literal
 * integer argument to `.status()`, or null if no literal status was found.
 *
 * Example:  res.status(503).json({})  →  503
 *           res.status(code).json({}) →  null  (variable, not a literal)
 *           res.json({})              →  null  (no status call)
 */
function extractLiteralStatusCode(expr: ts.Expression): number | null {
  if (ts.isCallExpression(expr)) {
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "status" &&
      expr.arguments.length === 1
    ) {
      const arg = expr.arguments[0];
      if (ts.isNumericLiteral(arg)) return parseInt(arg.text, 10);
    }
    return extractLiteralStatusCode(expr.expression);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return extractLiteralStatusCode(expr.expression);
  }
  return null;
}

/**
 * Collect every object literal that is the first argument to a `.json()`
 * call anywhere in the handler tree, regardless of intermediate chaining
 * (covers `res.json({})`, `res.status(201).json({})`, `res.set(...).json({})`,
 * `return void res.status(403).json({})`, etc.).
 *
 * Only literals directly passed as arguments are collected; if the argument
 * is a variable we cannot statically inspect its shape and it is skipped.
 *
 * Calls where a literal error status code (≥ 400) is present in the chain are
 * marked `isErrorResponse: true` so callers can decide whether to check them
 * against the spec's 2xx schema (they should not).
 */
function collectResJsonLiterals(root: ts.Node): {
  literal: ts.ObjectLiteralExpression;
  hasSpread: boolean;
  isErrorResponse: boolean;
}[] {
  const results: {
    literal: ts.ObjectLiteralExpression;
    hasSpread: boolean;
    isErrorResponse: boolean;
  }[] = [];

  function walk(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "json" &&
      isResReceiver(node.expression.expression)
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const statusCode = extractLiteralStatusCode(node.expression.expression);
        const isErrorResponse = statusCode !== null && statusCode >= 400;
        const hasSpread = arg.properties.some(ts.isSpreadAssignment);
        results.push({ literal: arg, hasSpread, isErrorResponse });
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(root);
  return results;
}

// ── req.body field detection ──────────────────────────────────────────────────

/**
 * Collect all field names accessed from `req.body` anywhere in the handler.
 *
 * Covers three patterns:
 *
 * 1. Type-assertion:  `req.body as { field: T }` → extracts from TypeLiteral
 * 2. Destructuring:   `const { field } = req.body` (initializer may be cast)
 *                     `const { field } = req.body as { field: T }`
 * 3. Property access: `req.body.field` / `req.body?.field`
 *
 * Returns an array of field-name groups, one per access site.  Callers check
 * each group against the spec's requestFields.
 */
function collectReqBodyFieldAccesses(root: ts.Node): string[][] {
  const results: string[][] = [];

  function walk(node: ts.Node) {
    // ── Pattern 1: `req.body as { ... }` ─────────────────────────────────────
    if (ts.isAsExpression(node) && isReqBody(node.expression)) {
      const fields = typeLiteralFields(node.type);
      if (fields.length > 0) results.push(fields);
    }
    // Angle-bracket form: `<{ ... }>req.body`
    if (
      ts.isTypeAssertionExpression &&
      ts.isTypeAssertionExpression(node) &&
      isReqBody(node.expression)
    ) {
      const fields = typeLiteralFields(node.type);
      if (fields.length > 0) results.push(fields);
    }

    // ── Pattern 2: destructuring `const { field } = req.body` ────────────────
    if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (init && isReqBody(stripCast(init))) {
        if (ts.isObjectBindingPattern(node.name)) {
          const fields: string[] = [];
          for (const el of node.name.elements) {
            // Binding elements: `{ field }` or `{ alias: field }` — we want
            // the *property name* (the key being read from req.body), which is
            // `el.propertyName ?? el.name`.
            const propName = el.propertyName ?? el.name;
            if (ts.isIdentifier(propName)) fields.push(propName.text);
          }
          if (fields.length > 0) results.push(fields);
        }
      }
    }

    // ── Pattern 3: `req.body.field` or `req.body?.field` ─────────────────────
    if (ts.isPropertyAccessExpression(node)) {
      // req.body.field — expression is req.body, name is field
      if (isReqBody(node.expression)) {
        results.push([node.name.text]);
      }
    }
    // Optional chaining: req.body?.field is a ChainExpression in some AST
    // representations, but ts parses it as PropertyAccessExpression with
    // questionDotToken set.  The check above already covers it.

    ts.forEachChild(node, walk);
  }
  walk(root);
  return results;
}

// ── Violation type ────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  method: string;
  specPath: string;
  kind: "response" | "requestBody";
  undeclaredFields: string[];
  note?: string;
}

// ── Per-file analysis ─────────────────────────────────────────────────────────

/**
 * Convert an Express route path to an OpenAPI path:
 *   /:id/description  →  /{id}/description
 *   /                 →  <prefix>   (treat "/" as the mounted prefix itself)
 */
function expressToOpenApiPath(expressPath: string, prefix: string): string {
  const normalised = expressPath.replace(/:([a-zA-Z_]\w*)/g, "{$1}");
  if (normalised === "/") return prefix || "/";
  return prefix + normalised;
}

function analyzeFile(
  filePath: string,
  prefix: string,
  specOps: Map<
    string,
    { requestFields: Set<string>; responseFields: Set<string> }
  >,
): Violation[] {
  if (!existsSync(filePath)) return [];

  const src = readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];

  function walk(node: ts.Node) {
    // Find router.METHOD(routePath, ...middleware?, handler)
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["get", "post", "put", "patch", "delete"].includes(callee.name.text)
      ) {
        const httpMethod = callee.name.text.toUpperCase();
        const args = node.arguments;

        // First arg must be a string literal path (skip regex routes like barcode)
        if (args.length >= 2 && ts.isStringLiteral(args[0])) {
          const openApiPath = expressToOpenApiPath(args[0].text, prefix);
          const opKey = `${httpMethod} ${openApiPath}`;
          const specOp = specOps.get(opKey);

          if (specOp) {
            // This route is declared in the spec — check every handler arg
            // (some routes have middleware before the final handler).
            for (let i = 1; i < args.length; i++) {
              const handler = args[i];
              if (
                !ts.isArrowFunction(handler) &&
                !ts.isFunctionExpression(handler)
              )
                continue;

              // ── Response literal check ──────────────────────────────────
              if (specOp.responseFields.size > 0) {
                for (const {
                  literal,
                  hasSpread,
                  isErrorResponse,
                } of collectResJsonLiterals(handler)) {
                  // Skip error responses (4xx/5xx with literal status code) —
                  // those are not schema-modelled in the spec and are allowed
                  // to use non-spec fields like `error`, `status`, etc.
                  if (isErrorResponse) continue;

                  const keys = objectLiteralKeys(literal);
                  const undeclared = keys.filter(
                    (k) =>
                      !specOp.responseFields.has(k) &&
                      !ALLOWED_ERROR_KEYS.has(k),
                  );
                  if (undeclared.length > 0) {
                    violations.push({
                      file: filePath,
                      method: httpMethod,
                      specPath: openApiPath,
                      kind: "response",
                      undeclaredFields: undeclared,
                      note: hasSpread
                        ? "object literal also contains spread(s) whose shape was not checked"
                        : undefined,
                    });
                  }
                }
              }

              // ── Request-body field check ────────────────────────────────
              if (specOp.requestFields.size > 0) {
                for (const fields of collectReqBodyFieldAccesses(handler)) {
                  const undeclared = fields.filter(
                    (f) => !specOp.requestFields.has(f),
                  );
                  if (undeclared.length > 0) {
                    violations.push({
                      file: filePath,
                      method: httpMethod,
                      specPath: openApiPath,
                      kind: "requestBody",
                      undeclaredFields: undeclared,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  return violations;
}

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
