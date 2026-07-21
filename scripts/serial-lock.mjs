#!/usr/bin/env node
/**
 * serial-lock.mjs — crash-safe cross-process serialization for heavy steps.
 *
 * TEMPLATE — adaptation points:
 *   1. LOCK PATH: default is .local/serial.lock relative to this script's
 *      PARENT directory — copy this template into your project's scripts/
 *      directory so the default lands under the repo root, or set
 *      SERIAL_LOCK_FILE explicitly.
 *   2. ENV VAR NAMES: SERIAL_LOCK_* — rename to suit your project, but keep
 *      the holder-PID reentrancy variable (SERIAL_LOCK_HELD_PID) or nested
 *      wrapped commands will deadlock against their own ancestor.
 *   3. TIMEOUTS: tune TIMEOUT_MS / HEARTBEAT_MS / STALE_HEARTBEAT_MS /
 *      MAX_HOLD_MS to your longest legitimate step.
 *
 * Problem: several heavy steps (typecheck, unit tests, e2e suites, lint)
 * may be triggered at the same time on one machine. The suites contend for
 * CPU, run budgets calibrated for an idle machine get breached even though
 * every test passes, and there are real races: concurrent codegen
 * regenerating the same file, and port collisions between e2e suites.
 *
 * Fix: each heavy command is wrapped as
 *   node scripts/serial-lock.mjs -- <command...>
 * The wrapper acquires a global exclusive lock file BEFORE the wrapped
 * command starts, so any budget timer inside the command only starts
 * ticking once the step actually has the machine to itself. Steps queue up
 * and run one at a time in whatever order they win the lock.
 *
 * Stale-lock handling (three layers, checked by waiting processes):
 *  1. Dead-pid reclaim: the lock file records the holder pid; if that
 *     process is no longer alive the lock is reclaimed.
 *  2. Stale-heartbeat reclaim: the holder touches the lock file's mtime
 *     every HEARTBEAT_MS. If the mtime is older than STALE_HEARTBEAT_MS the
 *     holder is presumed gone even if its pid appears alive (pid reuse
 *     after SIGKILL) and the lock is reclaimed.
 *  3. Max-hold-age safety valve: if the lock has been held longer than
 *     MAX_HOLD_MS (holder hung but alive and heartbeating), waiters reclaim
 *     it with a loud warning rather than stalling until the wait timeout.
 *
 * Every forced reclaim logs loudly — treat those log lines as incidents to
 * investigate, never as noise.
 *
 * Lock file format: line 1 = holder pid, line 2 = acquire time (ms epoch).
 *
 * Reentrancy: commands may be double-wrapped (an outer serialized runner
 * invokes an inner script that wraps this lock again). Without reentrancy
 * the inner wrapper deadlocks waiting on the lock its own ancestor holds.
 * The holder exports SERIAL_LOCK_HELD_PID; a nested wrapper that sees a
 * live holder pid in that variable skips acquisition and runs the command
 * directly.
 */
import {
  openSync, closeSync, unlinkSync, mkdirSync, writeSync, readFileSync,
  utimesSync, statSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const lockFile = process.env.SERIAL_LOCK_FILE
  ? resolve(process.env.SERIAL_LOCK_FILE)
  : resolve(root, ".local", "serial.lock");
const lockDir = dirname(lockFile);

const POLL_INTERVAL_MS = Number(process.env.SERIAL_LOCK_POLL_MS || 1_000);
// Generous: a full e2e suite can hold the lock for a long time, and several
// steps may be queued behind it.
const TIMEOUT_MS = Number(process.env.SERIAL_LOCK_TIMEOUT_MS || 3 * 60 * 60 * 1000);
// Holder refreshes the lock mtime this often.
const HEARTBEAT_MS = Number(process.env.SERIAL_LOCK_HEARTBEAT_MS || 30_000);
// Waiters treat a lock whose mtime is older than this as abandoned
// (covers SIGKILLed wrapper whose pid got reused by an unrelated process).
const STALE_HEARTBEAT_MS = Number(process.env.SERIAL_LOCK_STALE_HEARTBEAT_MS || 5 * 60 * 1000);
// Safety valve: no single step may hold the lock longer than this.
const MAX_HOLD_MS = Number(process.env.SERIAL_LOCK_MAX_HOLD_MS || 2 * 60 * 60 * 1000);

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("Usage: serial-lock.mjs -- <command...>");
  process.exit(2);
}
const command = argv.slice(sep + 1);
const commandLabel = command.join(" ");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readLockInfo() {
  const lines = readFileSync(lockFile, "utf8").split("\n");
  const pid = Number(lines[0]?.trim());
  const acquiredAt = Number(lines[1]?.trim());
  const mtimeMs = statSync(lockFile).mtimeMs;
  return { pid, acquiredAt, mtimeMs };
}

function tryAcquire() {
  try {
    const fd = openSync(lockFile, "wx");
    try { writeSync(fd, `${process.pid}\n${Date.now()}\n`); } catch { /* best-effort */ }
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale-lock reclaim paths — see header comment.
    try {
      const { pid: holderPid, acquiredAt, mtimeMs } = readLockInfo();
      const now = Date.now();
      let reason = null;
      if (Number.isInteger(holderPid) && holderPid > 0 && !pidAlive(holderPid)) {
        reason = `held by dead pid ${holderPid}`;
      } else if (now - mtimeMs > STALE_HEARTBEAT_MS) {
        reason = `heartbeat stale for ${Math.round((now - mtimeMs) / 1000)}s (pid ${holderPid} presumed reused/gone)`;
      } else if (Number.isFinite(acquiredAt) && acquiredAt > 0 && now - acquiredAt > MAX_HOLD_MS) {
        reason = `held for ${Math.round((now - acquiredAt) / 60000)} min by pid ${holderPid}, ` +
          `exceeding the ${Math.round(MAX_HOLD_MS / 60000)} min max-hold safety valve — holder appears hung`;
        console.error(`[serial-lock] WARNING: forcibly reclaiming lock: ${reason}`);
      }
      if (reason) {
        console.log(`[serial-lock] reclaiming stale lock (${reason})`);
        try { unlinkSync(lockFile); } catch { /* raced with another reclaimer */ }
      }
    } catch { /* lock vanished between open and read — just retry */ }
    return false;
  }
}

let lockAcquired = false;
let heartbeatTimer = null;
function releaseLock() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (!lockAcquired) return;
  lockAcquired = false;
  try {
    const { pid: holderPid } = readLockInfo();
    if (holderPid === process.pid) unlinkSync(lockFile);
  } catch { /* already gone */ }
}

function startHeartbeat() {
  heartbeatTimer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockFile, now, now);
    } catch { /* lock reclaimed out from under us — nothing to refresh */ }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

async function acquireWithTimeout() {
  const deadline = Date.now() + TIMEOUT_MS;
  let logged = false;
  while (true) {
    if (tryAcquire()) return;
    if (Date.now() >= deadline) {
      console.error(
        `[serial-lock] timed out after ${(TIMEOUT_MS / 60000).toFixed(0)} min waiting for ${lockFile}. ` +
        "If no other serialized step is running, delete the lock file manually.",
      );
      process.exit(3);
    }
    if (!logged) {
      console.log("[serial-lock] another serialized step holds the lock — queued, waiting…");
      logged = true;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
}

mkdirSync(lockDir, { recursive: true });

// Reentrancy: if an ancestor serial-lock wrapper already holds the lock,
// acquiring here would deadlock — the child waits forever on a lock its own
// ancestor holds. The holder exports SERIAL_LOCK_HELD_PID to its children;
// if it is set and that holder is still alive, run the command directly
// without re-acquiring.
const heldPid = Number(process.env.SERIAL_LOCK_HELD_PID || 0);
if (Number.isInteger(heldPid) && heldPid > 0 && heldPid !== process.pid && pidAlive(heldPid)) {
  console.log(
    `[serial-lock] lock already held by ancestor pid ${heldPid} — running reentrantly: ${commandLabel}`,
  );
  const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(sig); } catch { /* already gone */ }
      }
      process.exit(1);
    });
  }
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
} else {
  let child = null;
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill(sig); } catch { /* already gone */ }
      }
      releaseLock();
      process.exit(1);
    });
  }

  const waitStart = Date.now();
  await acquireWithTimeout();
  lockAcquired = true;
  startHeartbeat();
  const waitedSecs = ((Date.now() - waitStart) / 1000).toFixed(1);
  console.log(`[serial-lock] lock acquired after ${waitedSecs}s wait — running: ${commandLabel}`);

  child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      SERIAL_LOCK_HELD_PID: String(process.pid),
      // Expose queue-wait time so wrapped commands can report whether a
      // budget breach happened under concurrent load (waited > 0) or solo.
      SERIAL_LOCK_WAIT_SECS: waitedSecs,
    },
  });
  child.on("exit", (code, signal) => {
    releaseLock();
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}
