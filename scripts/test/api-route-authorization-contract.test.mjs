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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));
const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");
const INDEX_PATH = join(ROUTES_DIR, "index.ts");
const MATRIX_PATH = join(ROUTES_DIR, "routeAccessMatrix.ts");

function normalizePath(path) {
  return path.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}

function matrixKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function parseRouteMounts(source) {
  const imports = new Map(
    [...source.matchAll(/import\s+(\w+)\s+from\s+"\.\/([^"]+)";/g)]
      .map((match) => [match[1], match[2]]),
  );
  const mounts = new Map();
  const mountPattern = /router\.use\((?:(["'])([^"']+)\1\s*,\s*)?(\w+)\s*\);/g;

  for (const match of source.matchAll(mountPattern)) {
    const moduleName = imports.get(match[3]);
    if (!moduleName) throw new Error(`Missing route import for ${match[3]}`);
    mounts.set(moduleName, normalizePath(`/api${match[2] ?? ""}`));
  }

  return mounts;
}

function parseAdminOnlyEntries(source) {
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
    const lineEnd = source.indexOf("\n", declarationStart);
    const declarationLine = source.slice(
      declarationStart,
      lineEnd === -1 ? source.length : lineEnd,
    );
    const path = normalizePath(`${mount}/${match[2]}`);
    const guard =
      declarationLine.match(/\b(requireApprovedAdminAuth|requireAdminAuth)\b/)?.[1] ??
      routerGuard;
    declarations.set(matrixKey(match[1], path), {
      guard,
      moduleName: null,
    });
  }

  return declarations;
}

const mounts = parseRouteMounts(readFileSync(INDEX_PATH, "utf8"));
const adminOnlyEntries = parseAdminOnlyEntries(readFileSync(MATRIX_PATH, "utf8"));
if (adminOnlyEntries.length === 0) {
  throw new Error("Route access matrix contains no admin-only entries");
}

const declarations = new Map();
for (const [moduleName, mount] of mounts) {
  const source = readFileSync(join(ROUTES_DIR, `${moduleName}.ts`), "utf8");
  for (const [key, declaration] of routeDeclarationsForModule(source, mount)) {
    declarations.set(key, { ...declaration, moduleName });
  }
}

const matrixEntries = new Map(
  adminOnlyEntries.map((entry) => [matrixKey(entry.method, entry.path), entry]),
);
const expectedGuardForAccess = {
  "admin-only": "requireAdminAuth",
  "approved-admin": "requireApprovedAdminAuth",
};
const missingOrWrongGuards = adminOnlyEntries
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
  `API route authorization contract: ${adminOnlyEntries.length} privileged declarations are fully inventoried, use the declared admin guard, and contain no MFA enforcement.`,
);