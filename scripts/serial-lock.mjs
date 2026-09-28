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
  statSync, readdirSync, rmSync, renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  assertValidationHostToolContract,
  getValidationHostTools,
  VALIDATION_HOST_TOOL_PROBE_TIMEOUT_MS,
} from "./validation-steps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const criticalHelper = resolve(here, "serial-lock-critical.mjs");
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function positiveIntegerSetting(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed > MAX_TIMER_DELAY_MS
  ) {
    console.error(
      `[serial-lock] invalid ${name}: ${JSON.stringify(value)}; ` +
      `expected a positive integer from 1 to ${MAX_TIMER_DELAY_MS} milliseconds, ` +
      "or omit the variable to use the documented default.",
    );
    process.exit(2);
  }
  return parsed;
}

const POLL_INTERVAL_MS = positiveIntegerSetting("SERIAL_LOCK_POLL_MS", 1_000);
// Generous: a full e2e suite can hold the lock for a long time, and several
// steps may be queued behind it.
const TIMEOUT_MS = positiveIntegerSetting("SERIAL_LOCK_TIMEOUT_MS", 3 * 60 * 60 * 1000);
// Holder refreshes the lock mtime this often.
const HEARTBEAT_MS = positiveIntegerSetting("SERIAL_LOCK_HEARTBEAT_MS", 30_000);
// Waiters treat a lock whose mtime is older than this as abandoned
// (covers SIGKILLed wrapper whose pid got reused by an unrelated process).
const STALE_HEARTBEAT_MS = positiveIntegerSetting(
  "SERIAL_LOCK_STALE_HEARTBEAT_MS",
  5 * 60 * 1000,
);
// Safety valve: no single step may hold the lock longer than this.
const MAX_HOLD_MS = positiveIntegerSetting("SERIAL_LOCK_MAX_HOLD_MS", 2 * 60 * 60 * 1000);
// Give an existing waiter a short head start before priority reorders the queue.
const PRIORITY_GRACE_MS = positiveIntegerSetting("SERIAL_LOCK_PRIORITY_GRACE_MS", 2_000);
// Commands run in their own process group so cancellation cannot strand a
// server or worker after the wrapper releases the serialization lock.
const PROCESS_GROUP_KILL_GRACE_MS = positiveIntegerSetting(
  "SERIAL_LOCK_KILL_GRACE_MS",
  15_000,
);
const PROCESS_GROUP_POLL_MS = positiveIntegerSetting(
  "SERIAL_LOCK_GROUP_POLL_MS",
  25,
);
const TIMEOUT_EXIT_CODE = 124;

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
const inheritedHeldPid = Number(process.env.SERIAL_LOCK_HELD_PID || 0);
const inheritedHeldResources = new Set(
  (process.env.SERIAL_LOCK_HELD_RESOURCES || (inheritedHeldPid > 0 ? "global" : ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const explicitLockFile = process.env.SERIAL_LOCK_FILE
  ? resolve(process.env.SERIAL_LOCK_FILE)
  : null;
const inheritedLockFile = process.env.SERIAL_LOCK_FILE
  ? resolve(process.env.SERIAL_LOCK_INHERITED_FILE || process.env.SERIAL_LOCK_FILE)
  : null;
const inheritedLockIsActive =
  inheritedLockFile &&
  Number.isInteger(inheritedHeldPid) &&
  inheritedHeldPid > 0 &&
  pidAlive(inheritedHeldPid);
const budgetValue = process.env.SERIAL_LOCK_BUDGET_MS;
let budgetMs = null;
if (budgetValue !== undefined) {
  budgetMs = Number(budgetValue);
  if (
    !/^[1-9]\d*$/.test(budgetValue) ||
    !Number.isSafeInteger(budgetMs) ||
    budgetMs > MAX_TIMER_DELAY_MS
  ) {
    console.error(
      `[serial-lock] invalid SERIAL_LOCK_BUDGET_MS: ${JSON.stringify(budgetValue)}; ` +
      `expected a positive integer from 1 to ${MAX_TIMER_DELAY_MS} milliseconds, ` +
      "or omit the variable for no execution budget.",
    );
    process.exit(2);
  }
}
const inheritedPathIsCurrent =
  inheritedLockIsActive && explicitLockFile === inheritedLockFile;
const defaultLockFile = resolve(
  root,
  ".local",
  lockResource === "global" ? "serial.lock" : `serial-${lockResource}.lock`,
);
const lockFile = inheritedPathIsCurrent
  ? inheritedHeldResources.has(lockResource) || inheritedHeldResources.has("global")
    ? inheritedLockFile
    : defaultLockFile
  : explicitLockFile || defaultLockFile;
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

function signalProcessGroup(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        child.kill(signal);
        return true;
      } catch {
        // The child exited between the group and direct signal attempts.
      }
    }
    return false;
  }
}

function terminateProcessGroup(child, onComplete) {
  if (!child?.pid) {
    onComplete();
    return;
  }

  let escalated = false;
  let deadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS;
  let timer = null;
  const finish = () => {
    if (timer) clearTimeout(timer);
    onComplete();
  };
  const poll = () => {
    if (!processGroupIsAlive(child.pid)) {
      finish();
      return;
    }
    if (!escalated && Date.now() >= deadline) {
      escalated = true;
      console.error("[serial-lock] WARNING: process group survived termination grace; sending SIGKILL.");
      signalProcessGroup(child, "SIGKILL");
      deadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS;
    } else if (escalated && Date.now() >= deadline) {
      // SIGKILL should make this branch unreachable on a healthy Linux host.
      // Keep polling rather than releasing the lock while an owned process
      // group is still observable.
      deadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS;
    }
    timer = setTimeout(poll, PROCESS_GROUP_POLL_MS);
  };

  signalProcessGroup(child, "SIGTERM");
  poll();
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
  let lockHolderPid = 0;
  try {
    lockHolderPid = Number(readFileSync(lockFile, "utf8").split("\n")[0]?.trim());
  } catch {
    // The lock may be created or released while taking this queue snapshot.
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
      if (!holderIsAlive(waiter.pid, waiter.startTicks)) {
        rmSync(queueFile, { force: true });
        continue;
      }
      const waiterPriority = Number(waiter.priority);
      const waiterQueuedAt = Number(waiter.queuedAt);
      if (!Number.isInteger(waiterPriority) || waiterPriority < 1 || waiterPriority > 9 || !Number.isFinite(waiterQueuedAt)) {
        rmSync(queueFile, { force: true });
        continue;
      }
      if (waiter.pid === lockHolderPid) continue;
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
  const probe = spawnSync("flock", ["--help"], {
    stdio: "ignore",
    timeout: VALIDATION_HOST_TOOL_PROBE_TIMEOUT_MS,
  });
  if (probe.error) {
    const detail = probe.error.code === "ETIMEDOUT"
      ? `the capability probe timed out after ${VALIDATION_HOST_TOOL_PROBE_TIMEOUT_MS}ms`
      : probe.error.code || probe.error.message;
    throw flockUnavailableError(detail);
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
    const probe = spawnSync(requirement.name, requirement.probeArgs, {
      stdio: "ignore",
      timeout: requirement.probeTimeoutMs,
    });
    if (probe.error || probe.status !== 0) {
      const detail = probe.error?.code === "ETIMEDOUT"
        ? `probe timed out after ${requirement.probeTimeoutMs}ms`
        : probe.error?.code || `probe exited ${probe.status ?? "without status"}`;
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
      result.status === 5
        ? `[serial-lock] WARNING: ${lockResource} lock ownership changed before release; refusing to remove the successor lock.`
        : `[serial-lock] WARNING: could not release ${lockResource} lock cleanly; stale recovery will reclaim it safely.`,
    );
  }
}

function startHeartbeat(onOwnershipLost) {
  heartbeatTimer = setInterval(() => {
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
        "0",
        String(process.pid),
        processStartTicks(process.pid) ?? "",
        "0",
        "0",
        "heartbeat",
        lockToken,
      ],
      { cwd: root, stdio: "ignore" },
    );
    if (result.status === 0 || result.status === 1) return;
    // A token mismatch means a waiter reclaimed this holder's lease. Any
    // other helper failure is also fail-closed: the holder must not continue
    // work after it can no longer prove ownership.
    onOwnershipLost();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

function spawnDetachedWorker(workerEnv = process.env, onStdout = null) {
  const worker = spawn(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: workerEnv,
  });
  // The worker owns private pipes, not the caller's descriptors. pipe() pauses
  // the source when the caller is slow, bounding the wrapper's output buffer.
  // Do not exit on the worker's "exit" event: its pipes may still contain data.
  if (onStdout) worker.stdout.on("data", onStdout);
  worker.stdout.pipe(process.stdout, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  return worker;
}

function flushOutput(destination) {
  return new Promise((resolveFlush, rejectFlush) => {
    if (destination.destroyed || destination.writableEnded) {
      rejectFlush(new Error("output destination closed before worker output drained"));
      return;
    }
    // This callback runs after all writes queued by pipe() to this destination.
    // An empty write does not add data to the caller's output.
    destination.write("", (error) => error ? rejectFlush(error) : resolveFlush());
  });
}

async function finishWorkerOutput() {
  await Promise.all([flushOutput(process.stdout), flushOutput(process.stderr)]);
}

function attachWorker(worker) {
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
      "attach",
      lockToken,
      String(worker.pid),
      processStartTicks(worker.pid) ?? "",
    ],
    { cwd: root, stdio: "ignore" },
  );
  return !result.error && result.status === 0;
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
const heldPid = inheritedHeldPid;
const heldResources = inheritedHeldResources;
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
  const child = spawnDetachedWorker();
  let terminationRequested = false;
  const terminateAndExit = (exitCode) => {
    if (terminationRequested) return;
    terminationRequested = true;
    terminateProcessGroup(child, () => process.exit(exitCode));
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      terminateAndExit(1);
    });
  }
  child.on("close", async (code, signal) => {
    if (terminationRequested) return;
    try {
      await finishWorkerOutput();
      if (!terminationRequested) process.exit(signal ? 1 : code ?? 1);
    } catch (error) {
      console.error(`[serial-lock] ERROR: worker output could not be forwarded: ${error.message}`);
      process.exit(1);
    }
  });
} else {
  let child = null;
  let terminationRequested = false;
  let activeStep = null;
  let markerTail = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stepMarker = /━━━ \[run-tier\] step: ([a-z][a-z0-9-]*) ━━━/g;
  function observeTierOutput(chunk) {
    const output = markerTail + stdoutDecoder.write(chunk);
    for (const match of output.matchAll(stepMarker)) activeStep = match[1];
    // Preserve split markers without retaining a full stream or slowing its relay.
    markerTail = output.slice(-128);
  }
  process.on("exit", releaseLock);
  const terminateAndExit = (exitCode) => {
    if (terminationRequested) return;
    terminationRequested = true;
    if (!child) {
      releaseLock();
      process.exit(exitCode);
      return;
    }
    terminateProcessGroup(child, () => {
      releaseLock();
      process.exit(exitCode);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      terminateAndExit(1);
    });
  }

  const waitStart = Date.now();
  await acquireWithTimeout();
  lockAcquired = true;
  const waitedSecs = ((Date.now() - waitStart) / 1000).toFixed(1);
  const acquiredAt = Date.now();
  console.log(`[serial-lock] ${lockResource} lock acquired after ${waitedSecs}s wait (priority ${priority}) — running: ${commandLabel}`);

  child = spawnDetachedWorker({
    ...process.env,
    SERIAL_LOCK_HELD_PID: String(process.pid),
    SERIAL_LOCK_HELD_RESOURCES: [...heldResources, lockResource]
      .filter((value, index, all) => all.indexOf(value) === index)
      .join(","),
    SERIAL_LOCK_HELD_TOKEN: lockToken,
    SERIAL_LOCK_FILE: lockFile,
    SERIAL_LOCK_INHERITED_FILE: lockFile,
    // Expose queue-wait time so wrapped commands can report whether a
    // budget breach happened under concurrent load (waited > 0) or solo.
    SERIAL_LOCK_WAIT_SECS: waitedSecs,
    SERIAL_LOCK_ACQUIRED_AT: String(acquiredAt),
  }, budgetMs === null ? null : observeTierOutput);
  if (!attachWorker(child)) {
    console.error(
      `[serial-lock] ERROR: could not confirm ${lockResource} worker ownership; terminating without running under an unverified lock.`,
    );
    terminationRequested = true;
    await new Promise((resolveTermination) => {
      terminateProcessGroup(child, resolveTermination);
    });
    releaseLock();
    process.exit(1);
  }
  startHeartbeat(() => terminateAndExit(1));
  if (budgetMs !== null) {
    budgetTimer = setTimeout(() => {
      console.error(
        `[serial-lock] ERROR: ${lockResource} budget of ${budgetMs}ms exceeded after acquisition ` +
        `(queue wait ${waitedSecs}s excluded; active step "${activeStep ?? "unknown"}"); terminating process group.`,
      );
      terminateAndExit(TIMEOUT_EXIT_CODE);
    }, budgetMs);
    budgetTimer.unref();
  }
  child.once("exit", () => {
    // A slow caller can keep the relay draining after the worker exits; that
    // time is not part of the wrapped command's execution budget.
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
  });
  child.on("close", async (code, signal) => {
    if (terminationRequested) return;
    try {
      await finishWorkerOutput();
      if (terminationRequested) return;
      releaseLock();
      process.exit(signal ? 1 : code ?? 1);
    } catch (error) {
      console.error(`[serial-lock] ERROR: worker output could not be forwarded: ${error.message}`);
      releaseLock();
      process.exit(1);
    }
  });
}
