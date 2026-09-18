#!/usr/bin/env node
/**
 * Guard: server-only packages (the Postgres driver, AI/LLM server SDKs, and
 * anything else holding API keys) must never be reachable from a mobile/web
 * client bundle.
 *
 * Forbidden targets = @workspace/db (hard baseline) plus every workspace
 * package whose package.json sets `"serverOnly": true`. To mark a new lib as
 * server-only, add that flag — no script change needed.
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
 * - Derives mobile/web client roots from each artifact's
 *   .replit-artifact/artifact.toml metadata.
 * - BFS from each client root; fails with the offending chain if
 *   @workspace/db is reachable.
 *
 * Run standalone:  node scripts/check-db-reachability.mjs
 * Self-test:       node scripts/check-db-reachability.mjs --self-test
 * CI: wired into the "lint" validation tier step (see scripts/validation-steps.mjs).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Baseline server-only packages that must always be guarded, even if their
// package.json flag is accidentally removed.
const BASELINE_FORBIDDEN_TARGETS = ["@workspace/db"];
// Additionally, any workspace package with `"serverOnly": true` in its
// package.json is treated as a forbidden target (API keys, server SDKs, etc.).
// Artifact kinds that produce a browser/client bundle. Any new artifact with
// one of these kinds is automatically included in the reachability scan.
const CLIENT_ARTIFACT_KINDS = new Set(["mobile", "web"]);

// Development-only artifacts must be listed by package name instead of being
// omitted from the inventory. A new design/tooling artifact therefore fails
// closed until its exclusion is deliberately reviewed here.
const DEVELOPMENT_ONLY_ARTIFACT_EXCLUSIONS = new Map([
  [
    "@workspace/mockup-sandbox",
    "Canvas is a development-only design preview, not a production client bundle",
  ],
]);

const SERVER_ARTIFACT_KINDS = new Set(["api"]);

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

function readArtifactKind(root, dir) {
  const relativeDir = relative(root, dir).split("/");
  if (relativeDir.length !== 2 || relativeDir[0] !== "artifacts") return null;

  const metadataPath = join(dir, ".replit-artifact", "artifact.toml");
  if (!existsSync(metadataPath)) {
    throw new Error(
      `check-db-reachability: artifact package ${relativeDir[1]} is missing ` +
        `.replit-artifact/artifact.toml; every artifact must declare its kind`,
    );
  }
  const metadata = readFileSync(metadataPath, "utf8");
  const match = metadata.match(/^\s*kind\s*=\s*"([^"]+)"\s*$/m);
  if (!match) {
    throw new Error(
      `check-db-reachability: artifact package ${relativeDir[1]} has no ` +
        `declared kind in .replit-artifact/artifact.toml`,
    );
  }
  return match[1];
}

export function buildGraph(root) {
  const packages = new Map(); // name -> { dir, deps: Set<string> }
  const dirs = readWorkspaceGlobs(root).flatMap((g) => expandGlob(root, g));
  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.name) continue;
    packages.set(pkg.name, {
      dir,
      pkg,
      deps: new Set(),
      serverOnly: pkg.serverOnly === true,
      artifactKind: readArtifactKind(root, dir),
    });
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

export function collectForbiddenTargets(packages) {
  const targets = new Set(BASELINE_FORBIDDEN_TARGETS);
  for (const [name, entry] of packages) {
    if (entry.serverOnly) targets.add(name);
  }
  return [...targets].sort();
}

export function collectClientRoots(packages) {
  const roots = [];
  for (const [name, entry] of packages) {
    if (!entry.artifactKind) continue;
    if (CLIENT_ARTIFACT_KINDS.has(entry.artifactKind)) {
      roots.push(name);
      continue;
    }
    if (SERVER_ARTIFACT_KINDS.has(entry.artifactKind)) continue;
    const exclusionReason = DEVELOPMENT_ONLY_ARTIFACT_EXCLUSIONS.get(name);
    if (exclusionReason) {
      if (entry.artifactKind !== "design") {
        throw new Error(
          `check-db-reachability: development-only exclusion for ${name} ` +
            `does not match its artifact kind "${entry.artifactKind}"`,
        );
      }
      continue;
    }
    throw new Error(
      `check-db-reachability: artifact ${name} has unclassified kind ` +
        `"${entry.artifactKind}"; classify it as a client/server artifact or ` +
        `add an explicit development-only exclusion`,
    );
  }
  if (roots.length === 0) {
    throw new Error("check-db-reachability: no client artifacts were found in the workspace");
  }
  return roots.sort();
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
  // serverOnly-flag detection: flagged packages become forbidden targets.
  const flagGraph = mk({ app: ["ai-lib"], "ai-lib": [], "@workspace/db": [] });
  flagGraph.get("ai-lib").serverOnly = true;
  cases.push(
    {
      name: "serverOnly-flagged package reachable",
      graph: flagGraph,
      target: "ai-lib",
      expectChain: true,
    },
    {
      name: "serverOnly flag collected into targets",
      graph: flagGraph,
      custom: () => {
        const targets = collectForbiddenTargets(flagGraph);
        return targets.includes("ai-lib") && targets.includes("@workspace/db");
      },
    },
  );
  let ok = true;
  for (const c of cases) {
    if (c.custom) {
      const pass = c.custom();
      console.log(`${pass ? "ok" : "FAIL"}: self-test "${c.name}"`);
      if (!pass) ok = false;
      continue;
    }
    const chain = findPathTo(c.graph, "app", c.target ?? "@workspace/db");
    const pass = Boolean(chain) === c.expectChain;
    console.log(`${pass ? "ok" : "FAIL"}: self-test "${c.name}"${chain ? ` (${chain.join(" -> ")})` : ""}`);
    if (!pass) ok = false;
  }

  const inventoryGraph = mk({
    "@workspace/parts-id": ["shared"],
    "@workspace/browser-preview": ["deep-shared"],
    "@workspace/mockup-sandbox": [],
    "@workspace/api-server": [],
    shared: [],
    "deep-shared": ["server-lib"],
    "server-lib": ["@workspace/db"],
    "@workspace/db": [],
  });
  inventoryGraph.get("@workspace/parts-id").artifactKind = "mobile";
  inventoryGraph.get("@workspace/browser-preview").artifactKind = "web";
  inventoryGraph.get("@workspace/mockup-sandbox").artifactKind = "design";
  inventoryGraph.get("@workspace/api-server").artifactKind = "api";

  const inventoryRoots = collectClientRoots(inventoryGraph);
  const expectedRoots = ["@workspace/browser-preview", "@workspace/parts-id"];
  const inventoryPass =
    JSON.stringify(inventoryRoots) === JSON.stringify(expectedRoots) &&
    !inventoryRoots.includes("@workspace/mockup-sandbox") &&
    !inventoryRoots.includes("@workspace/api-server");
  console.log(
    `${inventoryPass ? "ok" : "FAIL"}: self-test "client roots include newly added browser artifacts and only explicit dev exclusions"`,
  );
  if (!inventoryPass) ok = false;

  const browserLeak = findPathTo(inventoryGraph, "@workspace/browser-preview", "@workspace/db");
  const browserLeakPass =
    browserLeak?.join(" -> ") ===
    "@workspace/browser-preview -> deep-shared -> server-lib -> @workspace/db";
  console.log(
    `${browserLeakPass ? "ok" : "FAIL"}: self-test "new browser root rejects a deep forbidden dependency"${browserLeak ? ` (${browserLeak.join(" -> ")})` : ""}`,
  );
  if (!browserLeakPass) ok = false;

  const unclassifiedGraph = mk({ "@workspace/future-artifact": [] });
  unclassifiedGraph.get("@workspace/future-artifact").artifactKind = "unknown";
  let rejectedUnclassified = false;
  try {
    collectClientRoots(unclassifiedGraph);
  } catch {
    rejectedUnclassified = true;
  }
  console.log(
    `${rejectedUnclassified ? "ok" : "FAIL"}: self-test "unclassified artifact is rejected"`,
  );
  if (!rejectedUnclassified) ok = false;

  // Real-repo sanity: link: edge from parts-id must be present in the graph.
  const real = buildGraph(ROOT);
  const realRoots = collectClientRoots(real);
  const partsId = real.get("@workspace/parts-id");
  if (!partsId || partsId.deps.size === 0 || !realRoots.includes("@workspace/parts-id")) {
    console.log("FAIL: self-test: @workspace/parts-id missing or has no local dep edges");
    ok = false;
  } else {
    console.log(
      `ok: self-test: client roots: ${realRoots.join(", ")}; ` +
        `@workspace/parts-id local edges: ${[...partsId.deps].join(", ")}`,
    );
  }
  return ok;
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }

  const packages = buildGraph(ROOT);

  const forbiddenTargets = collectForbiddenTargets(packages);

  for (const target of BASELINE_FORBIDDEN_TARGETS) {
    if (!packages.has(target)) {
      console.error(
        `check-db-reachability: could not find package ${target} in the workspace; ` +
          `the check would be vacuous. Update scripts/check-db-reachability.mjs.`,
      );
      process.exit(1);
    }
  }

  let failed = false;
  const clientRoots = collectClientRoots(packages);
  for (const rootName of clientRoots) {
    for (const target of forbiddenTargets) {
      const chain = findPathTo(packages, rootName, target);
      if (chain) {
        failed = true;
        console.error(
          `\nFORBIDDEN DEPENDENCY: ${target} is reachable from ${rootName}:\n` +
            `  ${chain.join("  ->  ")}\n\n` +
            `Server-only code must never ship to the client. Break this chain by\n` +
            `moving the shared code out of the package that imports ${target},\n` +
            `or by removing the local dependency edge.`,
        );
      } else {
        console.log(`ok: ${target} is not reachable from ${rootName}`);
      }
    }
  }

  process.exit(failed ? 1 : 0);
}

main();
