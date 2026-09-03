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
 *   node scripts/serial-lock.mjs --resource codegen --priority 80 -- <command...>
 * The wrapper acquires an exclusive resource lock BEFORE the wrapped
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
 * Lock file format: line 1 = holder pid, line 2 = acquire time (ms epoch),
 * line 3 = queue priority, line 4 = Linux process start tick (PID reuse guard).
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
  utimesSync, statSync, readdirSync, rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
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
  console.error("Usage: serial-lock.mjs [--resource <name>] [--priority <n>] -- <command...>");
  process.exit(2);
}
const optionArgs = argv.slice(0, sep);
function optionValue(name, fallback) {
  const index = optionArgs.indexOf(name);
  return index >= 0 && optionArgs[index + 1] ? optionArgs[index + 1] : fallback;
}
const lockResource = String(
  process.env.SERIAL_LOCK_RESOURCE || optionValue("--resource", "global"),
).trim().replace(/[^a-zA-Z0-9._-]/g, "-") || "global";
const priority = Number(optionValue("--priority", process.env.SERIAL_LOCK_PRIORITY || 0));
if (!Number.isFinite(priority)) {
  console.error(`[serial-lock] invalid priority: ${optionValue("--priority", process.env.SERIAL_LOCK_PRIORITY || "")}`);
  process.exit(2);
}
const lockFile = process.env.SERIAL_LOCK_FILE
  ? resolve(process.env.SERIAL_LOCK_FILE)
  : resolve(root, ".local", lockResource === "global" ? "serial.lock" : `serial-${lockResource}.lock`);
const lockDir = dirname(lockFile);
const queueDir = resolve(root, ".local", "serial-lock-queues", lockResource);
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

function processStartTicks(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

function readLockInfo() {
  const lines = readFileSync(lockFile, "utf8").split("\n");
  const pid = Number(lines[0]?.trim());
  const acquiredAt = Number(lines[1]?.trim());
  const holderPriority = Number(lines[2]?.trim() || 0);
  const startTicks = lines[3]?.trim() || null;
  const mtimeMs = statSync(lockFile).mtimeMs;
  return { pid, acquiredAt, holderPriority, startTicks, mtimeMs };
}

function holderIsAlive(holderPid, startTicks) {
  if (!pidAlive(holderPid)) return false;
  return !startTicks || processStartTicks(holderPid) === startTicks;
}

function enqueue() {
  mkdirSync(queueDir, { recursive: true });
  const queueFile = resolve(queueDir, `${process.pid}.json`);
  const fd = openSync(queueFile, "w");
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, priority, queuedAt: Date.now(), startTicks: processStartTicks(process.pid) }));
  } finally {
    closeSync(fd);
  }
}

function dequeue() {
  try { unlinkSync(resolve(queueDir, `${process.pid}.json`)); } catch { /* already gone */ }
}

function higherPriorityWaiterExists() {
  let entries;
  try {
    entries = readdirSync(queueDir);
  } catch {
    return false;
  }
  let found = false;
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === `${process.pid}.json`) continue;
    const queueFile = resolve(queueDir, entry);
    try {
      const waiter = JSON.parse(readFileSync(queueFile, "utf8"));
      if (!holderIsAlive(waiter.pid, waiter.startTicks) && Date.now() - waiter.queuedAt > STALE_HEARTBEAT_MS) {
        rmSync(queueFile, { force: true });
        continue;
      }
      if (Number(waiter.priority) > priority) found = true;
    } catch {
      rmSync(queueFile, { force: true });
    }
  }
  return found;
}

function tryAcquire() {
  if (higherPriorityWaiterExists()) return false;
  try {
    const fd = openSync(lockFile, "wx");
    try {
      writeSync(fd, `${process.pid}\n${Date.now()}\n${priority}\n${processStartTicks(process.pid) ?? ""}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale-lock reclaim paths — see header comment.
    try {
      const { pid: holderPid, acquiredAt, startTicks, mtimeMs } = readLockInfo();
      const now = Date.now();
      let reason = null;
      if (Number.isInteger(holderPid) && holderPid > 0 && !holderIsAlive(holderPid, startTicks)) {
        reason = `held by dead or reused pid ${holderPid}`;
      } else if (now - mtimeMs > STALE_HEARTBEAT_MS) {
        reason = `heartbeat stale for ${Math.round((now - mtimeMs) / 1000)}s (pid ${holderPid} presumed reused/gone)`;
      } else if (Number.isFinite(acquiredAt) && acquiredAt > 0 && now - acquiredAt > MAX_HOLD_MS) {
        reason = `held for ${Math.round((now - acquiredAt) / 60000)} min by pid ${holderPid}, ` +
          `exceeding the ${Math.round(MAX_HOLD_MS / 60000)} min max-hold safety valve — holder appears hung`;
      }
      if (reason) {
        console.error(`[serial-lock] WARNING: forcibly reclaiming ${lockResource} lock: ${reason}`);
        console.log(`[serial-lock] reclaiming stale lock (${reason})`);
        try { unlinkSync(lockFile); } catch { /* raced with another reclaimer */ }
      }
    } catch { /* lock vanished between open and read — just retry */ }
    return false;
  }
}

let lockAcquired = false;
let heartbeatTimer = null;
let budgetTimer = null;
function releaseLock() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
  dequeue();
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
  enqueue();
  while (true) {
    if (tryAcquire()) return;
    if (Date.now() >= deadline) {
      console.error(
        `[serial-lock] timed out after ${(TIMEOUT_MS / 60000).toFixed(0)} min waiting for ${lockResource} (${lockFile}). ` +
        "If no other serialized step is running, delete the lock file manually.",
      );
      dequeue();
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
const heldResources = new Set(
  (process.env.SERIAL_LOCK_HELD_RESOURCES || (heldPid > 0 ? "global" : ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (
  Number.isInteger(heldPid) &&
  heldPid > 0 &&
  heldPid !== process.pid &&
  pidAlive(heldPid) &&
  (heldResources.has(lockResource) || heldResources.has("global"))
) {
  console.log(
    `[serial-lock] ${lockResource} lock already held by ancestor pid ${heldPid} — running reentrantly: ${commandLabel}`,
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
  const acquiredAt = Date.now();
  console.log(`[serial-lock] ${lockResource} lock acquired after ${waitedSecs}s wait (priority ${priority}) — running: ${commandLabel}`);

  child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      SERIAL_LOCK_HELD_PID: String(process.pid),
      SERIAL_LOCK_HELD_RESOURCES: [...heldResources, lockResource]
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(","),
      // Expose queue-wait time so wrapped commands can report whether a
      // budget breach happened under concurrent load (waited > 0) or solo.
      SERIAL_LOCK_WAIT_SECS: waitedSecs,
      SERIAL_LOCK_ACQUIRED_AT: String(acquiredAt),
    },
  });
  const budgetMs = Number(process.env.SERIAL_LOCK_BUDGET_MS || 0);
  if (Number.isFinite(budgetMs) && budgetMs > 0) {
    budgetTimer = setTimeout(() => {
      console.error(
        `[serial-lock] ERROR: ${lockResource} budget of ${budgetMs}ms exceeded after acquisition (queue wait ${waitedSecs}s excluded); terminating child.`,
      );
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          if (child && child.exitCode === null && child.signalCode === null) {
            console.error(`[serial-lock] WARNING: ${lockResource} child survived budget grace; sending SIGKILL.`);
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 15_000).unref();
      }
    }, budgetMs);
    budgetTimer.unref();
  }
  child.on("exit", (code, signal) => {
    releaseLock();
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}
