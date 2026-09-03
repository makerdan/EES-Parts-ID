#!/usr/bin/env node
/**
 * Compatibility entry point for callers that historically invoked the heavy
 * suite through a dedicated serial wrapper.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["scripts/run-tier.mjs", "heavy", ...args], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);