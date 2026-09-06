#!/usr/bin/env node
/**
 * Static contract for privileged API route declarations.
 *
 * The route access matrix is the reviewable audience contract. This check
 * verifies that every entry marked admin-only is also visibly guarded at its
 * router declaration, so a future privileged endpoint cannot rely only on
 * broad app-level authentication.
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
    /\{\s*method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*path:\s*"([^"]+)",\s*access:\s*"(public|approved-user|admin-only)"\s*\}/g;
  return [...source.matchAll(entryPattern)]
    .filter((match) => match[3] === "admin-only")
    .map((match) => ({ method: match[1], path: match[2], access: match[3] }));
}

function routeDeclarationsForModule(source, mount) {
  const declarationPattern =
    /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
  const declarations = new Map();

  for (const match of source.matchAll(declarationPattern)) {
    const declarationStart = match.index ?? 0;
    const lineEnd = source.indexOf("\n", declarationStart);
    const declarationLine = source.slice(
      declarationStart,
      lineEnd === -1 ? source.length : lineEnd,
    );
    const path = normalizePath(`${mount}/${match[2]}`);
    declarations.set(matrixKey(match[1], path), {
      guarded: /\brequireAdminAuth\b/.test(declarationLine),
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
    declarations.set(key, declaration);
  }
}

const missingGuards = adminOnlyEntries
  .filter((entry) => !declarations.get(matrixKey(entry.method, entry.path))?.guarded)
  .map((entry) => `${entry.method} ${entry.path} — intended audience: ${entry.access}`);

if (missingGuards.length > 0) {
  throw new Error([
    "Unguarded privileged API route declarations:",
    ...missingGuards.map((route) => `- ${route}`),
  ].join("\n"));
}

console.log(
  `API route authorization contract: ${adminOnlyEntries.length} admin-only declarations require requireAdminAuth.`,
);