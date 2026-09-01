#!/usr/bin/env node
/**
 * Sweep only the explicitly registered development ports.
 *
 * This is deliberately a thin entrypoint over free-ports.mjs so every caller
 * gets the same /proc discovery, caller-tree protection, escalation, and final
 * free-port confirmation.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "free-ports.mjs");
const result = spawnSync(process.execPath, [script, "--all-dev"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);