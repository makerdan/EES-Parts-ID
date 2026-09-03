#!/usr/bin/env node
/**
 * Shared development-port contract.
 *
 * The registry is intentionally plain JSON so shell scripts, Node services,
 * Metro, and Vite can all consume the same assignments without a package
 * dependency or a TOML parser.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_PATH = resolve(ROOT, "scripts", "dev-ports.json");
export const REPLIT_PATH = resolve(ROOT, ".replit");

export function readPortRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

export function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

export function getCleanupPorts(registry = readPortRegistry()) {
  return [...new Set(registry.cleanupPorts)];
}

export function assertPortContract({
  registry = readPortRegistry(),
  replit = readFileSync(REPLIT_PATH, "utf8"),
} = {}) {
  const errors = [];
  const workflowPorts = registry.workflowPorts;
  const fallbackPorts = registry.fallbackPorts;
  const legacyPorts = registry.legacyPorts;

  if (!workflowPorts || typeof workflowPorts !== "object") {
    errors.push("registry.workflowPorts must be an object");
  }
  if (!fallbackPorts || typeof fallbackPorts !== "object") {
    errors.push("registry.fallbackPorts must be an object");
  }
  if (!Array.isArray(legacyPorts)) {
    errors.push("registry.legacyPorts must be an array");
  }
  if (!Array.isArray(registry.cleanupPorts)) {
    errors.push("registry.cleanupPorts must be an array");
  }

  const checkMap = (label, map) => {
    if (!map || typeof map !== "object") return;
    const seen = new Map();
    for (const [name, value] of Object.entries(map)) {
      if (!isValidPort(value)) {
        errors.push(`${label}.${name} is not a valid TCP port: ${String(value)}`);
      }
      if (seen.has(value)) {
        errors.push(`${label} collision: ${name} and ${seen.get(value)} both use ${value}`);
      } else {
        seen.set(value, name);
      }
    }
  };
  checkMap("workflowPorts", workflowPorts);
  checkMap("fallbackPorts", fallbackPorts);

  if (Array.isArray(legacyPorts)) {
    const seen = new Set();
    for (const value of legacyPorts) {
      if (!isValidPort(value)) errors.push(`legacyPorts contains invalid port ${String(value)}`);
      if (seen.has(value)) errors.push(`legacyPorts collision: ${value} is listed more than once`);
      seen.add(value);
    }
  }

  if (fallbackPorts && registry.API_SERVER_PORT !== fallbackPorts.api) {
    errors.push("API_SERVER_PORT must match fallbackPorts.api");
  }
  if (fallbackPorts && registry.STATIC_SERVER_PORT !== fallbackPorts.static) {
    errors.push("STATIC_SERVER_PORT must match fallbackPorts.static");
  }
  if (fallbackPorts && registry.NATIVE_API_DEV_PORT !== fallbackPorts.nativeApi) {
    errors.push("NATIVE_API_DEV_PORT must match fallbackPorts.nativeApi");
  }

  const expectedCleanup = new Set([
    ...Object.values(workflowPorts ?? {}),
    ...Object.values(fallbackPorts ?? {}),
    ...(Array.isArray(legacyPorts) ? legacyPorts : []),
  ]);
  const actualCleanup = new Set(registry.cleanupPorts ?? []);
  for (const port of expectedCleanup) {
    if (!actualCleanup.has(port)) errors.push(`cleanupPorts is missing registered port ${port}`);
  }
  for (const port of actualCleanup) {
    if (!expectedCleanup.has(port)) errors.push(`cleanupPorts contains unregistered port ${port}`);
  }

  const workflowBlocks = replit.split("[[workflows.workflow]]").slice(1);
  const workflowPortsFromReplit = {};
  const allowedWorkflowNames = new Set([
    "artifacts/parts-id: expo",
    "artifacts/api-server: API Server",
    "artifacts/mockup-sandbox: Component Preview Server",
    "test-fast",
    "test-standard",
    "test-standard-plus",
    "test-heavy",
  ]);
  for (const block of workflowBlocks) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    if (!name) continue;
    if (name === "Project") {
      const projectTasks = [...block.matchAll(/^\s*args\s*=\s*"([^"]+)"/gm)].map((match) => match[1]);
      if (projectTasks.length !== 1 || projectTasks[0] !== "test-fast") {
        errors.push(`Project workflow must contain exactly args = "test-fast" (found ${projectTasks.join(", ") || "none"})`);
      }
      continue;
    }
    if (!allowedWorkflowNames.has(name)) {
      errors.push(`stale one-shot workflow declaration remains: ${name}`);
      continue;
    }
    if (name.startsWith("test-") && !block.includes("isValidation = true")) {
      errors.push(`${name} must be marked isValidation = true`);
    }
    if (name.startsWith("test-") && !block.includes(`args = "pnpm run ${name}"`)) {
      errors.push(`${name} must invoke pnpm run ${name}`);
    }
    if (name.startsWith("test-")) continue;
    const port = Number(block.match(/^\s*waitForPort\s*=\s*(\d+)/m)?.[1]);
    const key = name.includes("parts-id")
      ? "expo"
      : name.includes("api-server")
        ? "api"
        : "canvas";
    workflowPortsFromReplit[key] = port;
  }

  for (const [name, expected] of Object.entries(workflowPorts ?? {})) {
    if (workflowPortsFromReplit[name] !== expected) {
      errors.push(`.replit workflow port drift for ${name}: expected ${expected}, found ${String(workflowPortsFromReplit[name])}`);
    }
  }

  const configuredPorts = [...replit.matchAll(/^\s*localPort\s*=\s*(\d+)/gm)].map((match) => Number(match[1]));
  for (const port of configuredPorts) {
    if (!actualCleanup.has(port)) errors.push(`.replit localPort ${port} is absent from cleanupPorts`);
  }

  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = assertPortContract();
  if (errors.length > 0) {
    console.error("Port Authority contract FAILED:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Port Authority contract OK (${getCleanupPorts().length} registered cleanup ports).`);
}