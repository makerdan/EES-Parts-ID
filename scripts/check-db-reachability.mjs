#!/usr/bin/env node
/**
 * Guard: @workspace/db (the Postgres driver + Drizzle schema) must never be
 * reachable from the parts-id mobile/web client bundle.
 *
 * The ESLint no-restricted-imports rule in artifacts/parts-id catches DIRECT
 * imports of @workspace/db, but a transitive leak is still possible: if a new
 * shared lib is added that depends on @workspace/db and parts-id later depends
 * on that lib, the DB driver would silently end up in the browser bundle.
 *
 * What it does:
 * - Discovers all local packages from the `packages:` globs in
 *   pnpm-workspace.yaml (including nested ones like artifacts/parts-id/modules/*).
 * - Builds a dependency graph over local edges: `workspace:` specs (resolved
 *   by name) plus `link:` and `file:` specs (resolved by path to the target
 *   package's real name).
 * - BFS from each client root; fails with the offending chain if
 *   @workspace/db is reachable.
 *
 * Run standalone:  node scripts/check-db-reachability.mjs
 * Self-test:       node scripts/check-db-reachability.mjs --self-test
 * CI: wired into the "lint" validation workflow (see .replit).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_TARGET = "@workspace/db";
// Client-side packages that must never (transitively) depend on the DB driver.
const CLIENT_ROOTS = ["@workspace/parts-id"];

function readWorkspaceGlobs(root) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const lines = yaml.split("\n");
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/);
      if (m) globs.push(m[1].trim());
      else if (!/^\s*(#|$)/.test(line)) inPackages = false;
    }
  }
  if (globs.length === 0) {
    throw new Error("could not parse packages: globs from pnpm-workspace.yaml");
  }
  return globs;
}

function expandGlob(root, glob) {
  // Supports literal paths and trailing "/*" segments (matches pnpm's usage here).
  const dirs = [];
  const parts = glob.split("/");
  function walk(base, idx) {
    if (idx === parts.length) {
      dirs.push(base);
      return;
    }
    const part = parts[idx];
    if (part === "*") {
      if (!existsSync(base)) return;
      for (const d of readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== "node_modules") {
          walk(join(base, d.name), idx + 1);
        }
      }
    } else if (part === "**") {
      throw new Error(`unsupported "**" in workspace glob: ${glob}`);
    } else {
      walk(join(base, part), idx + 1);
    }
  }
  walk(root, 0);
  return dirs;
}

function readPackageName(dir) {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).name ?? null;
  } catch {
    return null;
  }
}

export function buildGraph(root) {
  const packages = new Map(); // name -> { dir, deps: Set<string> }
  const dirs = readWorkspaceGlobs(root).flatMap((g) => expandGlob(root, g));
  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.name) continue;
    packages.set(pkg.name, { dir, pkg, deps: new Set() });
  }
  for (const [, entry] of packages) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [depName, spec] of Object.entries(entry.pkg[field] ?? {})) {
        if (typeof spec !== "string") continue;
        if (spec.startsWith("workspace:")) {
          entry.deps.add(depName);
        } else if (spec.startsWith("link:") || spec.startsWith("file:")) {
          const rel = spec.replace(/^(link:|file:)/, "");
          const targetDir = resolve(entry.dir, rel);
          const realName = readPackageName(targetDir);
          // Use the target's real package name so name aliases can't hide edges;
          // fall back to the alias so unknown targets still create an edge.
          entry.deps.add(realName ?? depName);
        }
      }
    }
    delete entry.pkg;
  }
  return packages;
}

// BFS from root, tracking the path so we can print the offending chain.
export function findPathTo(packages, rootName, targetName) {
  if (!packages.has(rootName)) return null;
  const queue = [[rootName]];
  const seen = new Set([rootName]);
  while (queue.length > 0) {
    const path = queue.shift();
    const entry = packages.get(path[path.length - 1]);
    if (!entry) continue; // non-local dep, ignore
    for (const dep of entry.deps) {
      if (dep === targetName) return [...path, dep];
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push([...path, dep]);
      }
    }
  }
  return null;
}

function selfTest() {
  // Synthetic graphs proving the guard detects leaks through both
  // workspace:-style (named) and link:-style (resolved-name) edges.
  const mk = (edges) => {
    const g = new Map();
    for (const [name, deps] of Object.entries(edges)) {
      g.set(name, { dir: "/fake/" + name, deps: new Set(deps) });
    }
    return g;
  };
  const cases = [
    {
      name: "direct workspace edge",
      graph: mk({ app: ["shared"], shared: ["@workspace/db"], "@workspace/db": [] }),
      expectChain: true,
    },
    {
      name: "deep chain via linked module",
      graph: mk({
        app: ["lidar-measure"],
        "lidar-measure": ["shared"],
        shared: ["@workspace/db"],
        "@workspace/db": [],
      }),
      expectChain: true,
    },
    {
      name: "clean graph",
      graph: mk({ app: ["shared"], shared: [], "@workspace/db": [] }),
      expectChain: false,
    },
  ];
  let ok = true;
  for (const c of cases) {
    const chain = findPathTo(c.graph, "app", "@workspace/db");
    const pass = Boolean(chain) === c.expectChain;
    console.log(`${pass ? "ok" : "FAIL"}: self-test "${c.name}"${chain ? ` (${chain.join(" -> ")})` : ""}`);
    if (!pass) ok = false;
  }
  // Real-repo sanity: link: edge from parts-id must be present in the graph.
  const real = buildGraph(ROOT);
  const partsId = real.get("@workspace/parts-id");
  if (!partsId || partsId.deps.size === 0) {
    console.log("FAIL: self-test: @workspace/parts-id missing or has no local dep edges");
    ok = false;
  } else {
    console.log(`ok: self-test: @workspace/parts-id local edges: ${[...partsId.deps].join(", ")}`);
  }
  return ok;
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }

  const packages = buildGraph(ROOT);

  if (!packages.has(FORBIDDEN_TARGET)) {
    console.error(
      `check-db-reachability: could not find package ${FORBIDDEN_TARGET} in the workspace; ` +
        `the check would be vacuous. Update scripts/check-db-reachability.mjs.`,
    );
    process.exit(1);
  }

  let failed = false;
  for (const rootName of CLIENT_ROOTS) {
    if (!packages.has(rootName)) {
      console.error(
        `check-db-reachability: client root ${rootName} not found in workspace; ` +
          `update CLIENT_ROOTS in scripts/check-db-reachability.mjs.`,
      );
      failed = true;
      continue;
    }
    const chain = findPathTo(packages, rootName, FORBIDDEN_TARGET);
    if (chain) {
      failed = true;
      console.error(
        `\nFORBIDDEN DEPENDENCY: ${FORBIDDEN_TARGET} is reachable from ${rootName}:\n` +
          `  ${chain.join("  ->  ")}\n\n` +
          `The DB driver must never ship to the client. Break this chain by moving\n` +
          `the shared code out of the package that imports ${FORBIDDEN_TARGET},\n` +
          `or by removing the local dependency edge.`,
      );
    } else {
      console.log(`ok: ${FORBIDDEN_TARGET} is not reachable from ${rootName}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
