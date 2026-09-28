#!/usr/bin/env node
/**
 * Static contract for privileged API route declarations.
 *
 * The route access matrix is the reviewable audience contract. This check
 * verifies both directions of the contract: every privileged matrix entry is
 * visibly guarded at its router declaration, and every guarded declaration is
 * inventoried in the matrix under the access label for its exact guard.
 *
 * It also rejects the former MFA enforcement primitives from production admin
 * request handling. Admin authorization is role/status based; tests must not
 * be made green by an MFA bypass flag or fabricated Clerk factor claims.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import mountGraph from "../lib/api-route-mount-graph.cjs";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const { deriveMountGraph } = mountGraph;
const { parseRouteMounts } = mountGraph;
const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");
const INDEX_PATH = join(ROUTES_DIR, "index.ts");
const MATRIX_PATH = join(ROUTES_DIR, "routeAccessMatrix.ts");

function normalizePath(path) {
  return path.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}

function matrixKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
}

function parsePrivilegedEntries(source) {
  const entryPattern =
    /\{\s*method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*path:\s*"([^"]+)",\s*access:\s*"(public|approved-user|approved-admin|admin-only)"\s*\}/g;
  return [...source.matchAll(entryPattern)]
    .filter((match) => match[3] === "admin-only" || match[3] === "approved-admin")
    .map((match) => ({ method: match[1], path: match[2], access: match[3] }));
}

function routeDeclarationsForModule(source, mount) {
  const declarationPattern =
    /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  const declarations = new Map();
  const routerGuard = source.match(
    /router\.use\(\s*(requireApprovedAdminAuth|requireAdminAuth)\s*\)/,
  )?.[1];

  for (const match of source.matchAll(declarationPattern)) {
    const declarationStart = match.index ?? 0;
    const declarationArguments = source.slice(declarationStart + match[0].length);
    const handlerStart = declarationArguments.search(
      /,\s*(?:(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|(?:async\s+)?function\b)/s,
    );
    const middlewareSource = stripComments(
      handlerStart === -1
        ? declarationArguments.slice(0, declarationArguments.indexOf("\n"))
        : declarationArguments.slice(0, handlerStart),
    );
    const path = normalizePath(`${mount}/${match[2]}`);
    const guard = middlewareSource.match(
      /(?:^|,)\s*(requireApprovedAdminAuth|requireAdminAuth)\s*(?=,|$)/s,
    )?.[1] ?? routerGuard;
    declarations.set(matrixKey(match[1], path), {
      guard,
      moduleName: null,
    });
  }

  return declarations;
}

const expectedGuardForAccess = {
  "admin-only": "requireAdminAuth",
  "approved-admin": "requireApprovedAdminAuth",
};

function validatePrivilegedRouteGuards(privilegedEntries, declarations) {
  const matrixEntries = new Map(
    privilegedEntries.map((entry) => [matrixKey(entry.method, entry.path), entry]),
  );
  const missingOrWrongGuards = privilegedEntries
    .filter((entry) => {
      const declaration = declarations.get(matrixKey(entry.method, entry.path));
      return declaration?.guard !== expectedGuardForAccess[entry.access];
    })
    .map((entry) => {
      const declaration = declarations.get(matrixKey(entry.method, entry.path));
      return `${entry.method} ${entry.path} — expected ${expectedGuardForAccess[entry.access]}, found ${declaration?.guard ?? "no declaration/guard"}`;
    });

  if (missingOrWrongGuards.length > 0) {
    throw new Error([
      "Missing or incorrectly guarded privileged API route declarations:",
      ...missingOrWrongGuards.map((route) => `- ${route}`),
    ].join("\n"));
  }

  const unlistedGuardedRoutes = [...declarations]
    .filter(([, declaration]) => declaration.guard)
    .filter(([key, declaration]) => {
      const matrixEntry = matrixEntries.get(key);
      return !matrixEntry || expectedGuardForAccess[matrixEntry.access] !== declaration.guard;
    })
    .map(([key, declaration]) => `${key} — ${declaration.guard} in ${declaration.moduleName}.ts`);

  if (unlistedGuardedRoutes.length > 0) {
    throw new Error([
      "Guarded API route declarations missing or mislabeled in the access matrix:",
      ...unlistedGuardedRoutes.map((route) => `- ${route}`),
    ].join("\n"));
  }
}

const multilineFixture = routeDeclarationsForModule(
  `
    router.get(
      "/multiline",
      requireAdminAuth,
      async (_req, res) => res.json({ ok: true }),
    );
    router.get(
      "/near-miss",
      async (_req, res) => res.json({ guard: "requireAdminAuth" }),
    );
  `,
  "/api/fixture",
);
assert.equal(
  multilineFixture.get("GET /api/fixture/multiline")?.guard,
  "requireAdminAuth",
  "multiline admin guards must be recognized as middleware arguments",
);
assert.equal(
  multilineFixture.get("GET /api/fixture/near-miss")?.guard,
  undefined,
  "guard names inside a handler must not satisfy the privileged guard contract",
);

const unlistedNestedFixtureSources = new Map([
  [
    "root",
    `
      import childRouter from "./child";
      router.use("/nested", childRouter);
    `,
  ],
  [
    "child",
    `
      router.get("/secret", requireAdminAuth, async (_req, res) => res.json({ ok: true }));
    `,
  ],
]);
const unlistedNestedFixture = deriveMountGraph({
  rootSource: unlistedNestedFixtureSources.get("root"),
  rootMount: "/api/fixture",
  readModuleSource: (moduleName) => unlistedNestedFixtureSources.get(moduleName),
});
const unlistedNestedDeclarations = new Map();
for (const { moduleName, mount, source } of unlistedNestedFixture) {
  for (const [key, declaration] of routeDeclarationsForModule(source, mount)) {
    unlistedNestedDeclarations.set(key, { ...declaration, moduleName });
  }
}
assert.throws(
  () => validatePrivilegedRouteGuards([], unlistedNestedDeclarations),
  /GET \/api\/fixture\/nested\/secret/,
  "an unlisted guarded child reached through a nested mount must fail the authorization contract",
);

const extendedMountFixtureSources = new Map([
  [
    "root",
    `
      import { router as namedRouter } from "./child";
      import reExportedRouter from "./barrel";
      router.use("/named", namedRouter);
      router.use("/re-exported", reExportedRouter);
    `,
  ],
  [
    "barrel",
    `
      export { default } from "./child";
    `,
  ],
  [
    "child",
    `
      router.get("/protected", requireAdminAuth, async (_req, res) => res.json({ ok: true }));
      export { router };
      export default router;
    `,
  ],
]);
const extendedMountFixture = deriveMountGraph({
  rootSource: extendedMountFixtureSources.get("root"),
  rootMount: "/api/fixture",
  readModuleSource: (moduleName) => extendedMountFixtureSources.get(moduleName),
});
assert.deepEqual(
  extendedMountFixture.map(({ moduleName, mount }) => `${moduleName}@${mount}`),
  [
    "child@/api/fixture/named",
    "barrel@/api/fixture/re-exported",
    "child@/api/fixture/re-exported",
  ],
  "named imports and local re-exports must remain visible in the route mount graph",
);

const unsupportedMountFixtureSources = new Map([
  [
    "root",
    `
      import protectedRouter from "./protected";
      router.use("/protected", protectedRouter());
    `,
  ],
  [
    "protected",
    `
      router.get("/secret", requireAdminAuth, async (_req, res) => res.json({ ok: true }));
    `,
  ],
]);
assert.throws(
  () =>
    deriveMountGraph({
      rootSource: unsupportedMountFixtureSources.get("root"),
      rootMount: "/api/fixture",
      readModuleSource: (moduleName) => unsupportedMountFixtureSources.get(moduleName),
    }),
  /Unsupported route mount target protectedRouter\(\)/,
  "an unsupported mount expression must fail before a protected child can disappear from the inventory",
);
assert.throws(
  () =>
    parseRouteMounts(
      `
        import protectedRouter from "./protected";
        router.use("/protected", protectedRouter, extraMiddleware);
      `,
      "/api/fixture",
    ),
  /Unsupported route mount arguments/,
  "unsupported middleware chains must fail instead of guessing which argument is the child router",
);

const privilegedEntries = parsePrivilegedEntries(readFileSync(MATRIX_PATH, "utf8"));
const adminOnlyEntries = privilegedEntries.filter((entry) => entry.access === "admin-only");
const approvedAdminEntries = privilegedEntries.filter((entry) => entry.access === "approved-admin");
if (adminOnlyEntries.length === 0 || approvedAdminEntries.length === 0) {
  throw new Error("Route access matrix must contain both admin-only and approved-admin entries");
}

const declarations = new Map();
const mounts = deriveMountGraph({
  rootSource: readFileSync(INDEX_PATH, "utf8"),
  rootMount: "/api",
  readModuleSource: (moduleName) => readFileSync(join(ROUTES_DIR, `${moduleName}.ts`), "utf8"),
});
for (const { moduleName, mount, source } of mounts) {
  for (const [key, declaration] of routeDeclarationsForModule(source, mount)) {
    declarations.set(key, { ...declaration, moduleName });
  }
}

validatePrivilegedRouteGuards(privilegedEntries, declarations);
assert.equal(
  [...declarations.keys()].filter((key) => key === "GET /api/reference/help/admin").length,
  1,
  "nested privileged routes must be inventoried exactly once",
);

const mutationCases = [
  ["approved-admin", approvedAdminEntries[0]],
  ["admin-only", adminOnlyEntries[0]],
];
for (const [access, entry] of mutationCases) {
  const key = matrixKey(entry.method, entry.path);
  const mutatedDeclarations = new Map(declarations);
  mutatedDeclarations.set(key, { ...declarations.get(key), guard: undefined });
  assert.throws(
    () => validatePrivilegedRouteGuards(privilegedEntries, mutatedDeclarations),
    new RegExp(`${entry.method} ${entry.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*expected`),
    `unguarded ${access} mutation must fail the authorization contract`,
  );
}

const forbiddenMfaPatterns = [
  ["MFA_REQUIRED response", /\bMFA_REQUIRED\b/],
  ["SKIP_ADMIN_MFA bypass", /\bSKIP_ADMIN_MFA\b/],
  ["Clerk sessionClaims inspection", /\bsessionClaims\b/],
  ["Clerk amr factor inspection", /(?:\.\s*amr\b|\[\s*["']amr["']\s*\])/],
];
const adminHandlingFiles = new Set([
  join(ROOT, "artifacts/api-server/src/middlewares/requireAdminAuth.ts"),
  ...[...declarations.values()]
    .filter((declaration) => declaration.guard)
    .map((declaration) => join(ROUTES_DIR, `${declaration.moduleName}.ts`)),
]);
const forbiddenMfaUses = [];
for (const filePath of adminHandlingFiles) {
  const source = readFileSync(filePath, "utf8");
  for (const [label, pattern] of forbiddenMfaPatterns) {
    if (pattern.test(source)) {
      forbiddenMfaUses.push(`${filePath.slice(ROOT.length + 1)} — ${label}`);
    }
  }
}
if (forbiddenMfaUses.length > 0) {
  throw new Error([
    "MFA-specific behavior remains in administrator request handling:",
    ...forbiddenMfaUses.map((use) => `- ${use}`),
  ].join("\n"));
}

console.log(
  `API route authorization contract: ${adminOnlyEntries.length} admin-only and ${approvedAdminEntries.length} approved-admin declarations are fully inventoried, use the declared admin guard, and contain no MFA enforcement.`,
);