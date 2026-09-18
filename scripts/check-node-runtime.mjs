#!/usr/bin/env node
/**
 * Enforce the Node runtime shared by local, Replit, and GitHub validation.
 * .node-version pins the exact patch used by the process, while the package
 * engine range also accepts the Node interpreter used by the pnpm launcher.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const engineRange = packageJson.engines?.node;
const declared = readFileSync(".node-version", "utf8").trim();
const active = process.versions.node;
const exactVersion = /^(\d+)\.(\d+)\.(\d+)$/;
const issues = [];

function parseVersion(value) {
  const match = value.match(exactVersion);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const engineRangeMatch = engineRange?.match(/^>=(\d+\.\d+\.\d+)\s+<(\d+)(?:\.\d+\.\d+)?$/);
const minimum = engineRangeMatch ? parseVersion(engineRangeMatch[1]) : null;
const upperMajor = engineRangeMatch ? Number(engineRangeMatch[2]) : null;
const declaredVersion = parseVersion(declared);

if (!engineRangeMatch || !minimum || upperMajor === null) {
  issues.push(
    `package.json engines.node must be a bounded range like ">=24.12.0 <25", found ${engineRange || "<missing>"}`,
  );
}
if (!declaredVersion) {
  issues.push(`.node-version must contain one exact semver, found ${declared || "<missing>"}`);
}
if (
  minimum &&
  upperMajor !== null &&
  declaredVersion &&
  (compareVersions(declaredVersion, minimum) < 0 || declaredVersion[0] >= upperMajor)
) {
  issues.push(`.node-version (${declared}) is outside package.json engines.node (${engineRange})`);
}
if (declaredVersion && active !== declared) {
  issues.push(`active Node is ${active}, but the repository requires ${declared}`);
}

if (issues.length > 0) {
  console.error("Node runtime contract failed.");
  for (const issue of issues) console.error(`- ${issue}`);
  console.error(
    `Restore the declared toolchain so "node --version" reports v${declared || "<required-version>"}. ` +
      "In Replit, use the repository's nodejs-24 module and restart the workflow; elsewhere, " +
      "configure your version manager from .node-version. Then rerun validation.",
  );
  process.exit(1);
}

console.log(`Node runtime contract OK: ${active} (.node-version pin and package.json engine range agree)`);