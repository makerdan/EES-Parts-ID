#!/usr/bin/env node

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
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
  operation = "acquire",
  expectedToken = "",
  workerPidText = "",
  workerStartTicks = "",
] = process.argv.slice(2);

const priority = Number(priorityText);
const ownerPid = Number(ownerPidText);
const staleHeartbeatMs = Number(staleHeartbeatText);
const maxHoldMs = Number(maxHoldText);
const workerPid = Number(workerPidText);

const PROCESS_GROUP_KILL_GRACE_MS = Number(
  process.env.SERIAL_LOCK_KILL_GRACE_MS || 15_000,
);
const PROCESS_GROUP_POLL_MS = Number(
  process.env.SERIAL_LOCK_GROUP_POLL_MS || 25,
);

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

function processGroupIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const closeParen = stat.lastIndexOf(")");
        if (closeParen < 0) continue;
        const fields = stat.slice(closeParen + 2).split(/\s+/);
        if (fields[2] === String(pid) && fields[0] !== "Z") return true;
      } catch {
        // The process may have exited between /proc enumeration and read.
      }
    }
    return false;
  } catch {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function sleep(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function terminateWorkerGroup(candidatePid = workerPid, candidateStartTicks = workerStartTicks) {
  if (!Number.isInteger(candidatePid) || candidatePid <= 0) return true;
  if (!candidateStartTicks || !holderIsAlive(candidatePid, candidateStartTicks)) {
    return !processGroupIsAlive(candidatePid);
  }

  signalProcessGroup(candidatePid, "SIGTERM");
  const firstDeadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS;
  while (processGroupIsAlive(candidatePid) && Date.now() < firstDeadline) {
    sleep(PROCESS_GROUP_POLL_MS);
  }
  if (!processGroupIsAlive(candidatePid)) return true;

  console.error(
    "[serial-lock] WARNING: recovered worker group survived termination grace; sending SIGKILL.",
  );
  signalProcessGroup(candidatePid, "SIGKILL");
  const killDeadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS;
  while (processGroupIsAlive(candidatePid) && Date.now() < killDeadline) {
    sleep(PROCESS_GROUP_POLL_MS);
  }
  return !processGroupIsAlive(candidatePid);
}

function readLock() {
  const lines = readFileSync(lockFile, "utf8").split("\n");
  return {
    lines,
    token: lines[4] ?? "",
    workerPid: Number(lines[5]?.trim()),
    workerStartTicks: lines[6]?.trim() || null,
  };
}

try {
  const fd = openSync(lockFile, "wx");
  try {
    writeSync(
      fd,
      `${ownerPid}\n${Date.now()}\n${priority}\n${ownerStartTicks}\n${expectedToken}\n\n\n`,
    );
  } finally {
    closeSync(fd);
  }
  process.exit(0);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

if (operation === "release") {
  try {
    const { token: currentToken } = readLock();
    if (currentToken !== expectedToken) process.exit(5);
    unlinkSync(lockFile);
  } catch {
    // The lock was already released or reclaimed.
  }
  process.exit(0);
}

if (operation === "attach") {
  try {
    const lock = readLock();
    if (lock.token !== expectedToken) process.exit(5);
    if (!Number.isInteger(workerPid) || workerPid <= 0) process.exit(2);
    writeFileSync(
      lockFile,
      `${lock.lines.slice(0, 5).join("\n")}\n${workerPid}\n${workerStartTicks}\n`,
    );
    process.exit(0);
  } catch {
    process.exit(5);
  }
}

if (operation === "heartbeat") {
  try {
    const { token: currentToken } = readLock();
    if (currentToken !== expectedToken) process.exit(5);
    const now = new Date();
    utimesSync(lockFile, now, now);
    process.exit(0);
  } catch {
    process.exit(5);
  }
}

try {
  const stat = statSync(lockFile);
  const lock = readLock();
  const [pidLine, acquiredLine, , startTicksLine] = lock.lines;
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
    const liveMaxHoldReason = `held for ${Math.round((now - acquiredAt) / 60000)} min by pid ${holderPid}, ` +
      `exceeding the ${Math.round(maxHoldMs / 60000)} min max-hold safety valve — holder appears hung`;
    console.error(
      `[serial-lock] WARNING: refusing to reclaim a live ${lockResource} lock: ${liveMaxHoldReason}; ` +
      "waiting for the original holder to release it",
    );
    process.exit(4);
  }

  if (!reason) process.exit(4);

  if (!terminateWorkerGroup(lock.workerPid, lock.workerStartTicks)) {
    console.error(
      `[serial-lock] ERROR: refusing to reclaim ${lockResource} lock while its worker group is still alive`,
    );
    process.exit(4);
  }

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