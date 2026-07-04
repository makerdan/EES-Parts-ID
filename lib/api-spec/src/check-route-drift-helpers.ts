/**
 * check-route-drift-helpers.ts
 *
 * Pure, exported helpers used by check-route-drift.ts (the CLI entry-point).
 * Keeping them here lets the test suite import them without triggering
 * import.meta.url / process.exit() side-effects that live only in the script.
 */

import { readFileSync, existsSync } from "fs";
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
  kind: "response" | "requestBody";
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
