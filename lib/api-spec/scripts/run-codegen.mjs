/**
 * Internal API codegen runner.
 *
 * This file is intentionally not exposed as a package script. The public
 * `codegen` script owns the shared lock and invokes this runner as its child.
 * Refusing to run without that live lock prevents callers from bypassing the
 * serialization boundary by invoking the generator implementation directly.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const resource = "codegen";
const heldPid = Number(process.env.SERIAL_LOCK_HELD_PID || 0);
const heldResources = new Set(
  (process.env.SERIAL_LOCK_HELD_RESOURCES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const lockFile = process.env.SERIAL_LOCK_FILE;
const heldToken = process.env.SERIAL_LOCK_HELD_TOKEN;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function hasLiveCodegenLock() {
  if (
    !pidAlive(heldPid) ||
    (!heldResources.has(resource) && !heldResources.has("global")) ||
    !lockFile ||
    !heldToken
  ) {
    return false;
  }

  try {
    const [ownerPid, , , , lockToken] = readFileSync(lockFile, "utf8").split(
      "\n",
    );
    return (
      Number(ownerPid?.trim()) === heldPid && lockToken?.trim() === heldToken
    );
  } catch {
    return false;
  }
}

function requireLiveCodegenLock() {
  if (hasLiveCodegenLock()) return;
  console.error(
    "[api-spec codegen] refusing to run without the live shared codegen lock; " +
      "invoke `pnpm run codegen` instead",
  );
  process.exit(2);
}

function run(command, args, env = process.env) {
  execFileSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
}

requireLiveCodegenLock();
run("pnpm", ["run", "dependency:check"]);
run("pnpm", ["exec", "orval", "--config", "./orval.config.ts"]);
run("pnpm", ["-w", "run", "typecheck:libs"], {
  ...process.env,
  CODEGEN_ENSURE_SKIP: "1",
});
