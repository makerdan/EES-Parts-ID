#!/usr/bin/env node
import {
  checkGeneratedOutputs,
  formatGeneratedOutputFailures,
} from "./generated-output-check.mjs";

const allowUntracked = process.argv.includes("--allow-untracked");
const result = checkGeneratedOutputs({
  ...(allowUntracked ? { checkTracked: false } : {}),
});

if (!result.ok) {
  console.error("❌ Generated output inventory check failed:");
  console.error(formatGeneratedOutputFailures(result.failures));
  process.exit(1);
}

console.log(
  `✅ Generated output inventory is complete (${result.manifest.sourceFiles.length} source files checked).`,
);