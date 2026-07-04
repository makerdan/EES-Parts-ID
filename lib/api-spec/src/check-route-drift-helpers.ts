/**
 * check-route-drift-helpers.ts
 *
 * Pure, exported helpers used by check-route-drift.ts (the CLI entry-point).
 * Keeping them here lets the test suite import them without triggering
 * import.meta.url / process.exit() side-effects that live only in the script.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import ts from "typescript";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ALLOWED_ERROR_KEYS = new Set([
  "error",
  "message",
  "detail",
  "details",
  "job",
]);

// ── OpenAPI types ─────────────────────────────────────────────────────────────

export interface OpenApiSpec {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

export interface OperationObject {
  operationId?: string;
  requestBody?: {
    content?: { "application/json"?: { schema?: SchemaRef } };
  };
  responses?: Record<
    string,
    { content?: { "application/json"?: { schema?: SchemaRef } } }
  >;
}

export type SchemaRef = { $ref: string } | SchemaObject;

export interface SchemaObject {
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

// ── Violation type ────────────────────────────────────────────────────────────

export interface Violation {
  file: string;
  method: string;
  specPath: string;
  kind: "response" | "requestBody" | "missingHandler";
  undeclaredFields: string[];
  note?: string;
}

// ── Spec parsing ──────────────────────────────────────────────────────────────

function refName(ref: string): string {
  return ref.replace("#/components/schemas/", "");
}

export function collectSchemaFields(
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

export function buildSpecOperations(spec: OpenApiSpec): Map<
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

export function parsePrefixMap(indexPath: string): Map<string, string> {
  const src = readFileSync(indexPath, "utf-8");
  const sf = ts.createSourceFile(
    indexPath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

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

export function isResReceiver(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "res";
  if (ts.isParenthesizedExpression(expr)) return isResReceiver(expr.expression);
  if (ts.isCallExpression(expr)) return isResReceiver(expr.expression);
  if (ts.isPropertyAccessExpression(expr))
    return isResReceiver(expr.expression);
  return false;
}

export function isReqBody(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr)) {
    return (
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "req" &&
      expr.name.text === "body"
    );
  }
  if (ts.isElementAccessExpression(expr)) return false;
  return false;
}

export function stripCast(expr: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expr)) return stripCast(expr.expression);
  if (ts.isTypeAssertionExpression && ts.isTypeAssertionExpression(expr))
    return stripCast(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return stripCast(expr.expression);
  return expr;
}

export function typeLiteralFields(typeNode: ts.TypeNode): string[] {
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

/** Extract string keys from an ObjectLiteralExpression (non-spread only). */
export function objectLiteralKeys(node: ts.ObjectLiteralExpression): string[] {
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
  }
  return keys;
}

// ── res.json detection ────────────────────────────────────────────────────────

export function extractLiteralStatusCode(expr: ts.Expression): number | null {
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
 * Returns true when `expr` contains a `.status(arg)` call anywhere in its
 * receiver chain, regardless of whether `arg` is a literal or a variable.
 * Used to distinguish "no status call at all" (plain res.json) from "status
 * call with a non-literal argument" (res.status(code).json) so the latter can
 * be skipped instead of being misclassified as a success response.
 */
function hasStatusCall(expr: ts.Expression): boolean {
  if (ts.isCallExpression(expr)) {
    if (
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "status" &&
      expr.arguments.length === 1
    ) {
      return true;
    }
    return hasStatusCall(expr.expression);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return hasStatusCall(expr.expression);
  }
  return false;
}

export function collectResJsonLiterals(root: ts.Node): {
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
        const statusIsVariable =
          statusCode === null && hasStatusCall(node.expression.expression);
        if (!statusIsVariable) {
          const isErrorResponse = statusCode !== null && statusCode >= 400;
          const hasSpread = arg.properties.some(ts.isSpreadAssignment);
          results.push({ literal: arg, hasSpread, isErrorResponse });
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(root);
  return results;
}

// ── req.body field detection ──────────────────────────────────────────────────

export function collectReqBodyFieldAccesses(root: ts.Node): string[][] {
  const results: string[][] = [];

  function walk(node: ts.Node) {
    if (ts.isAsExpression(node) && isReqBody(node.expression)) {
      const fields = typeLiteralFields(node.type);
      if (fields.length > 0) results.push(fields);
    }
    if (
      ts.isTypeAssertionExpression &&
      ts.isTypeAssertionExpression(node) &&
      isReqBody(node.expression)
    ) {
      const fields = typeLiteralFields(node.type);
      if (fields.length > 0) results.push(fields);
    }

    if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (init && isReqBody(stripCast(init))) {
        if (ts.isObjectBindingPattern(node.name)) {
          const fields: string[] = [];
          for (const el of node.name.elements) {
            const propName = el.propertyName ?? el.name;
            if (ts.isIdentifier(propName)) fields.push(propName.text);
          }
          if (fields.length > 0) results.push(fields);
        }
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (isReqBody(node.expression)) {
        results.push([node.name.text]);
      }
    }

    ts.forEachChild(node, walk);
  }
  walk(root);
  return results;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function expressToOpenApiPath(
  expressPath: string,
  prefix: string,
): string {
  const normalised = expressPath.replace(/:([a-zA-Z_]\w*)/g, "{$1}");
  if (normalised === "/") return prefix || "/";
  return prefix + normalised;
}

// ── Per-file analysis ─────────────────────────────────────────────────────────

export function analyzeFile(
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
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["get", "post", "put", "patch", "delete"].includes(callee.name.text)
      ) {
        const httpMethod = callee.name.text.toUpperCase();
        const args = node.arguments;

        if (args.length >= 2 && ts.isStringLiteral(args[0])) {
          const openApiPath = expressToOpenApiPath(args[0].text, prefix);
          const opKey = `${httpMethod} ${openApiPath}`;
          const specOp = specOps.get(opKey);

          if (specOp) {
            for (let i = 1; i < args.length; i++) {
              const handler = args[i];
              if (
                !ts.isArrowFunction(handler) &&
                !ts.isFunctionExpression(handler)
              )
                continue;

              if (specOp.responseFields.size > 0) {
                for (const {
                  literal,
                  hasSpread,
                  isErrorResponse,
                } of collectResJsonLiterals(handler)) {
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

// ── Spec route coverage ───────────────────────────────────────────────────────

/**
 * Best-effort conversion of a regex literal's text (e.g. `/^\/barcode\/(.+)$/`)
 * to an OpenAPI-style path (e.g. `/barcode/{param}`).
 *
 * Returns null when the regex cannot be reliably mapped to a simple path
 * (contains remaining metacharacters after substitution, or doesn't start
 * with `/`).  Callers should skip routes whose path cannot be resolved rather
 * than emitting a false-positive violation.
 */
export function regexLiteralToOpenApiPath(regexText: string): string | null {
  // regexText = "/^\/barcode\/(.+)$/", "/^\/foo\/(\w+)$/i", etc.
  const m = regexText.match(/^\/(.+?)\/[gimsuy]*$/);
  if (!m) return null;

  let source = m[1];
  // Strip anchors
  source = source.replace(/^\^/, "").replace(/\$$/, "");
  // Unescape forward slashes
  source = source.replace(/\\\//g, "/");
  // Replace capture groups with {param}
  source = source.replace(/\([^)]*\)/g, "{param}");
  // Must start with /
  if (!source.startsWith("/")) return null;
  // Reject if remaining regex metacharacters are present (after {param} removal)
  const residual = source.replace(/\{param\}/g, "");
  if (/[.*+?^${}()|[\]\\]/.test(residual)) return null;

  return source;
}

/**
 * Walks a route file and returns the set of "METHOD /full/path" strings that
 * are registered in it, applying the given prefix.  Used by
 * checkSpecRouteCoverage to determine which spec paths have no handler.
 *
 * Handles both string-literal path arguments (`"/items"`) and regex-literal
 * path arguments (`/^\/barcode\/(.+)$/`) via best-effort conversion.
 * Non-convertible paths (variables, complex regexes) are skipped rather than
 * being flagged as false-positive missing handlers.
 */
export function collectRegisteredRoutes(
  filePath: string,
  prefix: string,
): Set<string> {
  if (!existsSync(filePath)) return new Set();

  const src = readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const routes = new Set<string>();

  function walk(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["get", "post", "put", "patch", "delete"].includes(callee.name.text)
      ) {
        const httpMethod = callee.name.text.toUpperCase();
        const args = node.arguments;
        if (args.length >= 1) {
          const pathArg = args[0];
          let openApiPath: string | null = null;

          if (ts.isStringLiteral(pathArg)) {
            openApiPath = expressToOpenApiPath(pathArg.text, prefix);
          } else if (
            pathArg.kind === ts.SyntaxKind.RegularExpressionLiteral
          ) {
            const regexPath = regexLiteralToOpenApiPath(
              (pathArg as ts.RegularExpressionLiteral).text,
            );
            if (regexPath !== null) {
              openApiPath = prefix + regexPath;
            }
          }
          // Non-string, non-regex (identifier / template literal / etc.) args
          // cannot be statically resolved and are intentionally skipped.

          if (openApiPath !== null) {
            routes.add(`${httpMethod} ${openApiPath}`);
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);

  return routes;
}

/**
 * Normalises path-parameter names in an OpenAPI-style path so that structural
 * comparisons are parameter-name-agnostic.
 *
 * `/inventory/{id}/barcodes` → `/inventory/{p}/barcodes`
 * `/barcode/{param}`         → `/barcode/{p}`
 *
 * This is intentionally internal to the coverage check: we only care whether
 * *a* parameter occupies a given segment, not what it is called.
 */
function normalizeParamNames(path: string): string {
  return path.replace(/\{[^}]+\}/g, "{p}");
}

/**
 * Returns Violation records (kind = "missingHandler") for every spec operation
 * that has no corresponding Express route registered across all handler files.
 *
 * Path-parameter names are normalised before comparison so that a regex route
 * whose capture group maps to `{param}` still matches a spec path that uses
 * `{code}` (or any other name) for the same segment.
 *
 * @param specOps   - The map built by buildSpecOperations()
 * @param prefixMap - The map built by parsePrefixMap() (filename → prefix)
 * @param routesDir - Absolute path to the routes directory (used to resolve filenames)
 */
export function checkSpecRouteCoverage(
  specOps: Map<
    string,
    { requestFields: Set<string>; responseFields: Set<string> }
  >,
  prefixMap: Map<string, string>,
  routesDir: string,
): Violation[] {
  // Build the set of normalised "METHOD normalised-path" keys from all handlers
  const normalizedRegistered = new Set<string>();
  for (const [filename, prefix] of prefixMap) {
    const filePath = resolve(routesDir, filename);
    collectRegisteredRoutes(filePath, prefix).forEach((r) => {
      const spaceIdx = r.indexOf(" ");
      normalizedRegistered.add(
        r.slice(0, spaceIdx) + " " + normalizeParamNames(r.slice(spaceIdx + 1)),
      );
    });
  }

  const violations: Violation[] = [];
  for (const key of specOps.keys()) {
    const spaceIdx = key.indexOf(" ");
    const normalizedKey =
      key.slice(0, spaceIdx) +
      " " +
      normalizeParamNames(key.slice(spaceIdx + 1));
    if (!normalizedRegistered.has(normalizedKey)) {
      violations.push({
        file: "(spec)",
        method: key.slice(0, spaceIdx),
        specPath: key.slice(spaceIdx + 1),
        kind: "missingHandler",
        undeclaredFields: [],
      });
    }
  }
  return violations;
}
