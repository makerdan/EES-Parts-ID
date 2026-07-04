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
  line?: number;
  method: string;
  specPath: string;
  kind: "response" | "requestBody" | "missingHandler" | "unguardedResponse" | "typeMismatch";
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

// ── Zod parse-guard check ─────────────────────────────────────────────────────

/**
 * Returns true when `expr` is already safe to pass directly to `res.json`
 * without a Zod `.parse()` guard:
 *
 *  - Object literals  → already checked by the field-drift detection above.
 *  - Array literals   → statically typed; no dynamic DB shape to guard.
 *  - Primitive literals (string / number / boolean / null) → fully covered.
 *  - `.parse(...)` call → the guard IS present; all good.
 *  - Parenthesised / cast expressions → unwrapped and re-checked.
 */
function isGuardedOrSkippable(expr: ts.Expression): boolean {
  const inner = stripCast(expr);

  if (ts.isObjectLiteralExpression(inner)) return true;
  if (ts.isArrayLiteralExpression(inner)) return true;
  if (
    ts.isStringLiteral(inner) ||
    ts.isNumericLiteral(inner) ||
    inner.kind === ts.SyntaxKind.TrueKeyword ||
    inner.kind === ts.SyntaxKind.FalseKeyword ||
    inner.kind === ts.SyntaxKind.NullKeyword ||
    inner.kind === ts.SyntaxKind.UndefinedKeyword
  )
    return true;

  if (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text === "parse"
  )
    return true;

  return false;
}

/**
 * Scans a route file for success-path `res.json(expr)` calls where `expr` is
 * NOT the result of a Zod `.parse()` call and is NOT a literal / object that is
 * already covered by the field-drift check.
 *
 * Only routes that are declared in `specOps` are examined (internal endpoints
 * that are intentionally undocumented are skipped, matching `analyzeFile`
 * behaviour).
 *
 * Callers can suppress a specific call by adding a `// spec:ignore-unguarded`
 * comment on the same source line.
 */
export function collectUnguardedJsonCalls(
  filePath: string,
  prefix: string,
  specOps: Map<
    string,
    { requestFields: Set<string>; responseFields: Set<string> }
  >,
): Violation[] {
  if (!existsSync(filePath)) return [];

  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];

  /**
   * Collect the names of all variables within `scope` that are directly
   * initialised from a `.parse()` or `.parseAsync()` call (e.g.
   * `const data = Schema.parse({...})`).  These count as guarded even though
   * the `.parse()` call is not the immediate argument to `res.json()`.
   */
  function collectParsedVarNames(scope: ts.Node): Set<string> {
    const parsed = new Set<string>();
    function walk(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name)
      ) {
        let init = node.initializer;
        // Unwrap `await expr`
        if (ts.isAwaitExpression(init)) init = init.expression;
        if (
          ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          (init.expression.name.text === "parse" ||
            init.expression.name.text === "parseAsync")
        ) {
          parsed.add(node.name.text);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(scope);
    return parsed;
  }

  function walkHandler(
    handler: ts.Node,
    httpMethod: string,
    openApiPath: string,
  ) {
    const parsedVarNames = collectParsedVarNames(handler);

    function isGuardedExpr(expr: ts.Expression): boolean {
      if (isGuardedOrSkippable(expr)) return true;
      // Also accept a bare identifier that was assigned from a .parse() call
      const stripped = stripCast(expr);
      if (ts.isIdentifier(stripped) && parsedVarNames.has(stripped.text))
        return true;
      return false;
    }

    function inner(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "json" &&
        isResReceiver(node.expression.expression)
      ) {
        const arg = node.arguments[0];
        if (!arg) {
          ts.forEachChild(node, inner);
          return;
        }

        const statusCode = extractLiteralStatusCode(node.expression.expression);
        const statusIsVariable =
          statusCode === null && hasStatusCall(node.expression.expression);

        if (!statusIsVariable && (statusCode === null || statusCode < 400)) {
          if (!isGuardedExpr(arg)) {
            const pos = sf.getLineAndCharacterOfPosition(node.getStart());
            const lineNumber = pos.line + 1;
            const lineText = lines[pos.line] ?? "";
            if (!lineText.includes("spec:ignore-unguarded")) {
              violations.push({
                file: filePath,
                line: lineNumber,
                method: httpMethod,
                specPath: openApiPath,
                kind: "unguardedResponse",
                undeclaredFields: [],
                note: "res.json() argument is not the result of a Zod .parse() call",
              });
            }
          }
        }
      }
      ts.forEachChild(node, inner);
    }
    inner(handler);
  }

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
              walkHandler(handler, httpMethod, openApiPath);
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

// ── Hand-crafted Zod type checks ──────────────────────────────────────────────

/**
 * Walks a Zod expression (e.g. `z.string().nullish().describe("...")`) and
 * extracts the base type identifier and whether `.optional()` / `.nullish()`
 * appears anywhere in the chain.
 *
 * Returns null when no recognisable `z.*` call is found (e.g. bare identifier
 * references to another schema).
 */
function extractZodInfo(
  expr: ts.Expression,
): { zodType: string; isOptional: boolean } | null {
  const methodsInChain: string[] = [];
  let current: ts.Expression = expr;

  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;

    const methodName = callee.name.text;
    methodsInChain.push(methodName);
    const receiver = callee.expression;

    // z.TYPE() — direct call on the z namespace
    if (ts.isIdentifier(receiver) && receiver.text === "z") {
      const isOptional = methodsInChain.some(
        (m) => m === "optional" || m === "nullish",
      );
      return { zodType: methodName, isOptional };
    }

    // z.coerce.TYPE() — call on z.coerce
    if (
      ts.isPropertyAccessExpression(receiver) &&
      ts.isIdentifier(receiver.expression) &&
      receiver.expression.text === "z" &&
      receiver.name.text === "coerce"
    ) {
      const isOptional = methodsInChain.some(
        (m) => m === "optional" || m === "nullish",
      );
      return { zodType: "coerce." + methodName, isOptional };
    }

    current = receiver;
  }

  return null;
}

/**
 * Builds a map of `fieldName → { specType, requiredIn, optionalInAny }` from
 * all scalar properties in the spec's component schemas.  Only `string`,
 * `number`, `integer`, and `boolean` fields are indexed; arrays and objects
 * are skipped.
 *
 * `requiredIn` lists schema names where the field is required.
 * `optionalInAny` is true when at least one schema contains the field without
 * requiring it (nullable / not in the required array).  When `optionalInAny`
 * is true the required check is suppressed to avoid false positives that arise
 * from the same field name appearing as required in one schema and optional in
 * another.
 */
function buildSpecFieldTypeMap(
  spec: OpenApiSpec,
): Map<string, { specType: string; requiredIn: string[]; optionalInAny: boolean }> {
  const fieldMap = new Map<
    string,
    { specType: string; requiredIn: string[]; optionalInAny: boolean }
  >();
  const schemas = spec.components?.schemas ?? {};

  for (const [schemaName, schema] of Object.entries(schemas)) {
    const s = schema as SchemaObject;
    if (!s.properties) continue;
    const requiredSet = new Set(s.required ?? []);

    for (const [fieldName, fieldSchema] of Object.entries(s.properties)) {
      if ("$ref" in fieldSchema) continue;
      const fs = fieldSchema as SchemaObject;
      const specType = fs.type;
      if (
        !specType ||
        !["string", "number", "integer", "boolean"].includes(specType)
      )
        continue;

      const isRequired = requiredSet.has(fieldName);
      const existing = fieldMap.get(fieldName);
      if (existing) {
        const typesCompatible =
          existing.specType === specType ||
          (existing.specType === "integer" && specType === "number") ||
          (existing.specType === "number" && specType === "integer");
        if (typesCompatible) {
          if (isRequired) {
            existing.requiredIn.push(schemaName);
          } else {
            existing.optionalInAny = true;
          }
        }
      } else {
        fieldMap.set(fieldName, {
          specType,
          requiredIn: isRequired ? [schemaName] : [],
          optionalInAny: !isRequired,
        });
      }
    }
  }

  return fieldMap;
}

/**
 * Returns true when a Zod base type is compatible with a spec-declared type.
 *
 *   spec integer / number → z.number()
 *   spec boolean          → z.boolean()
 *   spec string           → z.string()  OR  z.coerce.date() (for date-time fields)
 */
function isZodTypeCompatible(zodType: string, specType: string): boolean {
  switch (specType) {
    case "integer":
    case "number":
      return zodType === "number";
    case "boolean":
      return zodType === "boolean";
    case "string":
      return zodType === "string" || zodType === "coerce.date";
    default:
      return true;
  }
}

/**
 * Walks up the AST to find the name of the variable that the given node is
 * being assigned to (e.g. `const InventoryItemSchema = z.object({...})`).
 * Returns null when no enclosing variable declaration is found.
 */
function getEnclosingVariableName(node: ts.Node): string | null {
  let current: ts.Node = node;
  while (current.parent) {
    current = current.parent;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isClassDeclaration(current)
    ) {
      break;
    }
  }
  return null;
}

/**
 * Zod base types that represent compound shapes — arrays, objects, unions, etc.
 * Fields with these types are out of scope for the first-pass scalar check.
 */
const COMPOUND_ZOD_TYPES = new Set([
  "array",
  "object",
  "enum",
  "union",
  "discriminatedUnion",
  "intersection",
  "record",
  "map",
  "set",
  "tuple",
  "lazy",
  "nativeEnum",
]);

/**
 * Checks that scalar field types in the hand-crafted Zod schemas in
 * `lib/api-zod/src/inventoryRoutes.ts` are compatible with their
 * spec-declared counterparts.
 *
 * Only scalar types (string, number/integer, boolean) are checked.
 * Arrays, objects, unions, and enums are skipped (out of scope for first pass).
 * `z.coerce.date()` is treated as compatible with spec `type: string`.
 * Fields not found in any spec component schema are silently skipped.
 *
 * Generated schemas in `lib/api-zod/src/generated/` are never passed to this
 * function — the caller supplies only the hand-crafted source text.
 *
 * @param spec                  Parsed OpenAPI spec
 * @param inventoryRoutesSource Source text of inventoryRoutes.ts
 * @param inventoryRoutesPath   Absolute path (used in violation `.file` field)
 */
export function checkHandcraftedZodTypes(
  spec: OpenApiSpec,
  inventoryRoutesSource: string,
  inventoryRoutesPath: string,
): Violation[] {
  const fieldTypeMap = buildSpecFieldTypeMap(spec);

  const sf = ts.createSourceFile(
    inventoryRoutesPath,
    inventoryRoutesSource,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const violations: Violation[] = [];

  function walk(node: ts.Node) {
    // Find z.object({...}) calls
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.arguments.length >= 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const objLiteral = node.arguments[0] as ts.ObjectLiteralExpression;
      const schemaName = getEnclosingVariableName(node) ?? "(unknown schema)";

      for (const prop of objLiteral.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;

        const fieldName = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : null;
        if (!fieldName) continue;

        const zodInfo = extractZodInfo(prop.initializer);
        if (!zodInfo) continue; // bare identifier, template literal, etc. — skip

        if (COMPOUND_ZOD_TYPES.has(zodInfo.zodType)) continue; // out of scope

        const specField = fieldTypeMap.get(fieldName);
        if (!specField) continue; // field absent from spec — skip

        const typeMismatch = !isZodTypeCompatible(zodInfo.zodType, specField.specType);
        // Only flag a required mismatch when ALL spec schemas that declare this
        // field mark it as required.  If any schema has it as optional the
        // field name alone is ambiguous and we suppress the required check to
        // avoid false positives (e.g. imageUrl is required in UploadPhotoResponse
        // but optional/nullable in InventoryItem).
        const requiredMismatch =
          specField.requiredIn.length > 0 &&
          !specField.optionalInAny &&
          zodInfo.isOptional;

        if (!typeMismatch && !requiredMismatch) continue;

        const notes: string[] = [];
        if (typeMismatch) {
          notes.push(
            `field "${fieldName}": spec declares type "${specField.specType}" but Zod uses z.${zodInfo.zodType}()`,
          );
        }
        if (requiredMismatch) {
          notes.push(
            `field "${fieldName}": required in spec (schema: ${specField.requiredIn[0]}) but Zod marks it as optional/nullish`,
          );
        }

        violations.push({
          file: inventoryRoutesPath,
          method: schemaName,
          specPath: specField.requiredIn[0]
            ? `#/components/schemas/${specField.requiredIn[0]}`
            : "(spec)",
          kind: "typeMismatch",
          undeclaredFields: [fieldName],
          note: notes.join("; "),
        });
      }
    }

    ts.forEachChild(node, walk);
  }

  walk(sf);
  return violations;
}
