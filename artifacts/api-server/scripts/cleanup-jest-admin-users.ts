import { randomUUID } from "node:crypto";

import {
  cleanupJestAdminUsers,
  createJestInvocationId,
  formatJestAdminCleanupReport,
  type JestAdminCleanupMode,
} from "../src/lib/adminTestUserCleanup.ts";

function readOption(name: string): string | undefined {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

const args = new Set(process.argv.slice(2));
const modeFlags: Array<[string, JestAdminCleanupMode]> = [
  ["--all", "all"],
  ["--exact", "exact"],
  ["--stale", "stale"],
];
const selectedModes = modeFlags.filter(([flag]) => args.has(flag));

if (selectedModes.length !== 1) {
  console.error("Usage: cleanup-jest-admin-users.ts (--all|--exact|--stale) [--apply] [--invocation-id=...]");
  process.exit(1);
}

const [, mode] = selectedModes[0];
const invocationId =
  readOption("--invocation-id") ??
  process.env.JEST_INVOCATION_ID ??
  createJestInvocationId(randomUUID(), process.pid);

try {
  const report = await cleanupJestAdminUsers({
    mode,
    apply: args.has("--apply"),
    ...(mode === "exact" ? { invocationId } : {}),
  });
  console.log(formatJestAdminCleanupReport(report));
} catch (error) {
  console.error(
    `Jest admin cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}