#!/usr/bin/env node

import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";

const [
  lockFile,
  lockResource,
  priorityText,
  ownerPidText,
  ownerStartTicks = "",
  staleHeartbeatText,
  maxHoldText,
] = process.argv.slice(2);

const priority = Number(priorityText);
const ownerPid = Number(ownerPidText);
const staleHeartbeatMs = Number(staleHeartbeatText);
const maxHoldMs = Number(maxHoldText);

function processStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsAfterComm = stat.slice(closeParen + 2).split(/\s+/);
    return fieldsAfterComm[19] ?? null;
  } catch {
    return null;
  }
}

function holderIsAlive(pid, expectedStartTicks) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  if (!expectedStartTicks) return true;
  const actual = processStartTicks(pid);
  return actual !== null && actual === String(expectedStartTicks);
}

try {
  const fd = openSync(lockFile, "wx");
  try {
    writeSync(fd, `${ownerPid}\n${Date.now()}\n${priority}\n${ownerStartTicks}\n`);
  } finally {
    closeSync(fd);
  }
  process.exit(0);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

try {
  const stat = statSync(lockFile);
  const [pidLine, acquiredLine, , startTicksLine] = readFileSync(lockFile, "utf8").split("\n");
  const holderPid = Number(pidLine?.trim());
  const acquiredAt = Number(acquiredLine?.trim());
  const startTicks = startTicksLine?.trim() || null;
  const now = Date.now();
  let reason = null;

  if (Number.isInteger(holderPid) && holderPid > 0 && !holderIsAlive(holderPid, startTicks)) {
    reason = `held by dead or reused pid ${holderPid}`;
  } else if (now - stat.mtimeMs > staleHeartbeatMs) {
    reason = `heartbeat stale for ${Math.round((now - stat.mtimeMs) / 1000)}s (pid ${holderPid} presumed reused/gone)`;
  } else if (Number.isFinite(acquiredAt) && acquiredAt > 0 && now - acquiredAt > maxHoldMs) {
    reason = `held for ${Math.round((now - acquiredAt) / 60000)} min by pid ${holderPid}, ` +
      `exceeding the ${Math.round(maxHoldMs / 60000)} min max-hold safety valve — holder appears hung`;
  }

  if (!reason) process.exit(4);

  console.error(`[serial-lock] WARNING: forcibly reclaiming ${lockResource} lock: ${reason}`);
  console.log(`[serial-lock] reclaiming stale lock (${reason})`);
  try {
    unlinkSync(lockFile);
  } catch {
    // The holder may have released after inspection. Acquirers still serialize
    // on the kernel guard, so the parent can safely retry.
  }
  process.exit(3);
} catch {
  process.exit(4);
}