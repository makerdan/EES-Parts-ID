#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export function isApiActiveAtEntry({ port, socketTables, processArguments }) {
  for (const table of socketTables) {
    for (const row of table.split("\n").slice(1)) {
      const fields = row.trim().split(/\s+/);
      const localPort = Number.parseInt(fields[1]?.split(":")[1] ?? "", 16);
      if (fields[3] === "0A" && localPort === port) return true;
    }
  }

  return processArguments.some((args) => {
    const pnpmApiDev =
      args.some((arg) => /(?:^|\/)pnpm$/.test(arg)) &&
      args.includes("--filter") &&
      args.includes("@workspace/api-server") &&
      args.includes("run") &&
      args.includes("dev");
    const apiTsx =
      args.some((arg) => arg.includes("/artifacts/api-server/") && /\/tsx\/dist\/cli\.mjs$/.test(arg)) &&
      args.includes("src/index.ts");
    return pnpmApiDev || apiTsx;
  });
}

function readProcessArguments() {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((pid) => {
      try {
        return [readFileSync(join("/proc", pid, "cmdline"), "utf8").split("\0").filter(Boolean)];
      } catch (error) {
        // Short-lived processes disappear during enumeration; inaccessible
        // processes cannot establish whether this workspace's API is active.
        if (error?.code === "ENOENT" || error?.code === "EACCES") return [];
        throw error;
      }
    });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const root = resolve(dirname(scriptPath), "..");
    const port = JSON.parse(readFileSync(join(root, "scripts/dev-ports.json"), "utf8")).workflowPorts.api;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid registered API port");
    const socketTables = [readFileSync("/proc/net/tcp", "utf8")];
    try {
      socketTables.push(readFileSync("/proc/net/tcp6", "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    process.exitCode = isApiActiveAtEntry({
      port,
      socketTables,
      processArguments: readProcessArguments(),
    }) ? 0 : 1;
  } catch (error) {
    console.error(`[post-merge] API activity probe unavailable: ${error.message}`);
    process.exitCode = 2;
  }
}