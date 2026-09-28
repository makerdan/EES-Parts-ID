#!/usr/bin/env node
/**
 * Export the Parts ID browser bundle and reject server-only workspace modules
 * identified by the emitted source maps.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildGraph, collectForbiddenTargets } from "../../../scripts/check-db-reachability.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const ARTIFACT_ROOT = resolve(import.meta.dirname, "..");
const PACKAGE_NAME = "@workspace/parts-id";

function sourceMatchesDirectory(source, directory) {
  const relativeDirectory = relative(ROOT, directory).split("\\").join("/");
  const normalizedSource = source.replaceAll("\\", "/").replace(/^file:\/\//, "");
  return (
    normalizedSource === `/${relativeDirectory}` ||
    normalizedSource.startsWith(`/${relativeDirectory}/`) ||
    normalizedSource === relativeDirectory ||
    normalizedSource.startsWith(`${relativeDirectory}/`)
  );
}

export function findForbiddenBundleSources({
  outputDir,
  packages = buildGraph(ROOT),
  forbiddenTargets = collectForbiddenTargets(packages),
} = {}) {
  const sourcesByTarget = new Map(forbiddenTargets.map((target) => [target, []]));
  const jsRoot = join(outputDir, "_expo", "static", "js", "web");
  const mapFiles = readdirSync(jsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => join(jsRoot, entry.name));

  if (mapFiles.length === 0) {
    throw new Error(
      `[browser-bundle] ${PACKAGE_NAME}: Expo emitted no browser source maps; ` +
        "the bundle dependency boundary cannot be verified",
    );
  }

  for (const mapFile of mapFiles) {
    const map = JSON.parse(readFileSync(mapFile, "utf8"));
    for (const source of map.sources ?? []) {
      for (const target of forbiddenTargets) {
        const entry = packages.get(target);
        if (entry && sourceMatchesDirectory(source, entry.dir)) {
          sourcesByTarget.get(target).push({ mapFile, source });
        }
      }
    }
  }

  return new Map(
    [...sourcesByTarget].filter(([, sources]) => sources.length > 0),
  );
}

export function runPartsIdBrowserBundleCheck({
  outputDir = mkdtempSync(join(tmpdir(), "parts-id-browser-bundle-")),
  packages,
  forbiddenTargets,
  spawn = spawnSync,
} = {}) {
  let result;
  try {
    result = spawn(
      "pnpm",
      [
        "exec",
        "expo",
        "export",
        "--platform",
        "web",
        "--output-dir",
        outputDir,
        "--source-maps",
        "--no-bytecode",
        "--no-minify",
      ],
      {
        cwd: ARTIFACT_ROOT,
        env: {
          ...process.env,
          EXPO_PUBLIC_DOMAIN: process.env.EXPO_PUBLIC_DOMAIN || "browser-bundle.invalid",
          EXPO_PUBLIC_REPL_ID: process.env.EXPO_PUBLIC_REPL_ID || "browser-bundle-smoke",
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:
            process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ||
            process.env.CLERK_PUBLISHABLE_KEY ||
            "",
        },
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw new Error(`[browser-bundle] ${PACKAGE_NAME} export failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`[browser-bundle] ${PACKAGE_NAME} export failed with exit code ${result.status}`);
    }

    const forbidden = findForbiddenBundleSources({
      outputDir,
      ...(packages ? { packages } : {}),
      ...(forbiddenTargets ? { forbiddenTargets } : {}),
    });
    if (forbidden.size > 0) {
      const details = [...forbidden]
        .map(([target, sources]) => {
          const firstSource = sources[0];
          return `  - ${target}: ${firstSource.source} (${firstSource.mapFile})`;
        })
        .join("\n");
      throw new Error(
        `[browser-bundle] ${PACKAGE_NAME} contains forbidden server-only dependencies:\n${details}`,
      );
    }

    console.log(
      `[browser-bundle] ${PACKAGE_NAME} passed: emitted browser source maps contain no server-only workspace modules`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[browser-bundle]")) {
      throw error;
    }
    throw new Error(
      `[browser-bundle] ${PACKAGE_NAME} dependency check failed: ${error.message}`,
      { cause: error },
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exit(runPartsIdBrowserBundleCheck());
}