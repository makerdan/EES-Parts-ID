#!/usr/bin/env node
/**
 * Enforce the exact Node runtime shared by local, Replit, and GitHub
 * validation. The engine declaration and version file must agree, and the
 * process running this check must use that exact patch version.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expected = packageJson.engines?.node;
const declared = readFileSync(".node-version", "utf8").trim();
const active = process.versions.node;
const exactVersion = /^\d+\.\d+\.\d+$/;
const issues = [];

if (!expected || !exactVersion.test(expected)) {
  issues.push(`package.json engines.node must be one exact semver, found ${expected || "<missing>"}`);
}
if (!exactVersion.test(declared)) {
  issues.push(`.node-version must contain one exact semver, found ${declared || "<missing>"}`);
}
if (expected && declared && expected !== declared) {
  issues.push(`package.json engines.node (${expected}) does not match .node-version (${declared})`);
}
if (exactVersion.test(declared) && active !== declared) {
  issues.push(`active Node is ${active}, but the repository requires ${declared}`);
}

if (issues.length > 0) {
  console.error("Node runtime contract failed.");
  for (const issue of issues) console.error(`- ${issue}`);
  console.error(
    `Restore the declared toolchain so "node --version" reports v${declared || expected || "<required-version>"}. ` +
      "In Replit, use the repository's nodejs-24 module and restart the workflow; " +
      "elsewhere, configure your version manager from .node-version. Then rerun validation.",
  );
  process.exit(1);
}

console.log(`Node runtime contract OK: ${active} (package.json and .node-version agree)`);