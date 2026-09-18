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
 *   node scripts/serial-lock.mjs --resource codegen --priority 2 -- <command...>
 * The wrapper acquires an exclusive resource lock BEFORE the wrapped
 * command starts, so any budget timer inside the command only starts
 * ticking once the step actually has the machine to itself. Steps queue up
 * and run one at a time, with priority applied after a short grace period.
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
 *
 * Priority scale: integers 1 through 9, where 1 is highest precedence and 9
 * is lowest. The default is 5. A lower-precedence waiter yields to a
 * higher-precedence waiter only after the configured grace period, preventing
 * a just-arrived waiter from repeatedly bypassing an already queued peer.
 *
 * Acquisition and stale-holder reclaim run under a short kernel-backed flock
 * guard. The guard inode is intentionally persistent; flock releases ownership
 * when the helper exits or is killed, so a crashed waiter cannot strand it.
 */
import {
  openSync, closeSync, unlinkSync, mkdirSync, writeSync, readFileSync,
  utimesSync, statSync, readdirSync, rmSync, renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  assertValidationHostToolContract,
  getValidationHostTools,
} from "./validation-steps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const criticalHelper = resolve(here, "serial-lock-critical.mjs");
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
// Give an existing waiter a short head start before priority reorders the queue.
const PRIORITY_GRACE_MS = Number(process.env.SERIAL_LOCK_PRIORITY_GRACE_MS || 2_000);

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep === -1 || sep === argv.length - 1) {
  console.error("Usage: serial-lock.mjs [--resource <name>] [--priority <1-9>] -- <command...>");
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
const priorityIndex = optionArgs.indexOf("--priority");
const priorityValue = priorityIndex >= 0
  ? optionArgs[priorityIndex + 1]
  : process.env.SERIAL_LOCK_PRIORITY || "5";
const priority = Number(priorityValue);
if (!/^[1-9]$/.test(String(priorityValue))) {
  console.error(`[serial-lock] invalid priority: ${priorityValue ?? ""}; expected an integer from 1 to 9 (1 is highest)`);
  process.exit(2);
}
const lockFile = process.env.SERIAL_LOCK_FILE
  ? resolve(process.env.SERIAL_LOCK_FILE)
  : resolve(root, ".local", lockResource === "global" ? "serial.lock" : `serial-${lockResource}.lock`);
const lockDir = dirname(lockFile);
const queueDir = process.env.SERIAL_LOCK_QUEUE_DIR
  ? resolve(process.env.SERIAL_LOCK_QUEUE_DIR)
  : resolve(root, ".local", "serial-lock-queues", lockResource);
const command = argv.slice(sep + 1);
const commandLabel = command.join(" ");
const lockToken = randomUUID();

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

function holderIsAlive(holderPid, startTicks) {
  if (!pidAlive(holderPid)) return false;
  return !startTicks || processStartTicks(holderPid) === startTicks;
}

let queuedAt = 0;
let queueFilePath = null;
let queueTempFilePath = null;
function enqueue() {
  mkdirSync(queueDir, { recursive: true });
  const queueFile = resolve(queueDir, `${process.pid}.json`);
  const queueTempFile = `${queueFile}.${processStartTicks(process.pid) ?? "unknown"}.tmp`;
  queueFilePath = queueFile;
  queueTempFilePath = queueTempFile;
  queuedAt = Date.now();
  const fd = openSync(queueTempFile, "wx");
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, priority, queuedAt, startTicks: processStartTicks(process.pid) }));
  } finally {
    closeSync(fd);
  }
  renameSync(queueTempFile, queueFile);
}

function dequeue() {
  for (const path of [queueFilePath, queueTempFilePath]) {
    if (!path) continue;
    try { unlinkSync(path); } catch { /* already gone */ }
  }
  queueFilePath = null;
  queueTempFilePath = null;
}

function precedenceWaiterExists() {
  let entries;
  try {
    entries = readdirSync(queueDir);
  } catch {
    return false;
  }
  let found = false;
  const now = Date.now();
  const selfMatured = now - queuedAt >= PRIORITY_GRACE_MS;
  for (const entry of entries) {
    if (entry.endsWith(".tmp")) {
      const tempPid = Number(entry.split(".json.", 1)[0]);
      const tempFile = resolve(queueDir, entry);
      try {
        const ageMs = now - statSync(tempFile).mtimeMs;
        if (!holderIsAlive(tempPid, null) && ageMs > POLL_INTERVAL_MS * 2) {
          rmSync(tempFile, { force: true });
        }
      } catch { /* publication completed or another waiter cleaned it */ }
      continue;
    }
    if (!entry.endsWith(".json") || entry === `${process.pid}.json`) continue;
    const queueFile = resolve(queueDir, entry);
    try {
      const waiter = JSON.parse(readFileSync(queueFile, "utf8"));
      if (!holderIsAlive(waiter.pid, waiter.startTicks) && now - waiter.queuedAt > STALE_HEARTBEAT_MS) {
        rmSync(queueFile, { force: true });
        continue;
      }
      const waiterPriority = Number(waiter.priority);
      const waiterQueuedAt = Number(waiter.queuedAt);
      if (!Number.isInteger(waiterPriority) || waiterPriority < 1 || waiterPriority > 9 || !Number.isFinite(waiterQueuedAt)) {
        rmSync(queueFile, { force: true });
        continue;
      }
      const waiterMatured = now - waiterQueuedAt >= PRIORITY_GRACE_MS;
      const waiterQueuedFirst =
        waiterQueuedAt < queuedAt ||
        (waiterQueuedAt === queuedAt && Number(waiter.pid) < process.pid);
      if (selfMatured && waiterMatured) {
        if (waiterPriority < priority || (waiterPriority === priority && waiterQueuedFirst)) {
          found = true;
        }
      } else if (waiterQueuedFirst) {
        found = true;
      }
    } catch {
      rmSync(queueFile, { force: true });
    }
  }
  return found;
}

function flockUnavailableError(detail = "the command was not found") {
  return new Error(
    `[serial-lock] ERROR: the flock utility is unavailable for the ${lockResource} serialization path (${detail}). ` +
    "Install the host's standard flock utility (usually provided by util-linux); refusing to fall back to an unsafe lock implementation.",
  );
}

function ensureFlockAvailable() {
  const probe = spawnSync("flock", ["--help"], { stdio: "ignore" });
  if (probe.error) {
    throw flockUnavailableError(probe.error.code || probe.error.message);
  }
  if (probe.status !== 0) {
    throw flockUnavailableError(`the capability probe exited ${probe.status}`);
  }
}

function validationTierFromCommand() {
  const tierIndex = command.findIndex((argument) => argument.endsWith("run-tier.mjs"));
  const commandTier = tierIndex >= 0 ? command[tierIndex + 1] : null;
  return commandTier || process.env.VALIDATION_TIER || "fast";
}

function ensureValidationHostTools() {
  let requirements;
  try {
    const tier = validationTierFromCommand();
    assertValidationHostToolContract(tier);
    requirements = getValidationHostTools(tier);
  } catch (error) {
    console.error(
      `[serial-lock] ERROR: validation host-tool contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const missing = [];
  for (const requirement of requirements) {
    const probe = spawnSync(requirement.name, requirement.probeArgs, { stdio: "ignore" });
    if (probe.error || probe.status !== 0) {
      const detail = probe.error?.code || `probe exited ${probe.status ?? "without status"}`;
      missing.push({ ...requirement, detail });
    }
  }
  if (missing.length === 0) return true;

  const tier = validationTierFromCommand();
  console.error(
    `[validation-preflight] ERROR: ${missing.length} required host tool(s) are unavailable for ${tier} validation.`,
  );
  for (const requirement of missing) {
    console.error(
      `[validation-preflight] - ${requirement.name}: ${requirement.capability}; ` +
      `setup source: ${requirement.setup}; probe: ${requirement.detail}.`,
    );
  }
  console.error(
    "[validation-preflight] Refusing to queue validation or use an unsafe fallback. " +
    "Restore the listed host tools, then retry.",
  );
  return false;
}

function tryAcquire() {
  if (precedenceWaiterExists()) return false;
  const result = spawnSync(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      `${lockFile}.guard`,
      process.execPath,
      criticalHelper,
      lockFile,
      lockResource,
      String(priority),
      String(process.pid),
      processStartTicks(process.pid) ?? "",
      String(STALE_HEARTBEAT_MS),
      String(MAX_HOLD_MS),
      "acquire",
      lockToken,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw flockUnavailableError(result.error.code || result.error.message);
  }
  if (result.status === 0) return true;
  if ([1, 3, 4].includes(result.status)) return false;
  throw new Error(`[serial-lock] acquisition helper exited ${result.status ?? "without status"}`);
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
  const result = spawnSync(
    "flock",
    [
      "--exclusive",
      `${lockFile}.guard`,
      process.execPath,
      criticalHelper,
      lockFile,
      lockResource,
      "0",
      String(process.pid),
      processStartTicks(process.pid) ?? "",
      "0",
      "0",
      "release",
      lockToken,
    ],
    { cwd: root, stdio: "ignore" },
  );
  if (result.error || result.status !== 0) {
    // A failed release is safe: waiters can recover this tokenized lock using
    // the stale-heartbeat/dead-owner rules, and no successor can be removed
    // because the release helper checks the token under the same flock guard.
    console.error(
      `[serial-lock] WARNING: could not release ${lockResource} lock cleanly; stale recovery will reclaim it safely.`,
    );
  }
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

if (lockResource === "validation" && !ensureValidationHostTools()) {
  process.exit(2);
}
ensureFlockAvailable();
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
