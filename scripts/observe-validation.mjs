#!/usr/bin/env node
/**
 * Bridge a short-lived validation observer to a longer-running tier command.
 * A pending observer exits nonzero; only the persisted worker result can prove
 * that the full command finished successfully.
 *
 * Usage: node scripts/observe-validation.mjs start [--wait-ms N] -- <command ...>
 *        node scripts/observe-validation.mjs status <run-id>
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep runtime evidence inspectable in the workspace, outside the disposable
// .local skill/task mirror. Logs may include sensitive test output; never commit.
const stateDir = resolve(root, "validation-runs");
const self = fileURLToPath(import.meta.url);
const MAX_WAIT_MS = 540_000; // Leave room for the service's ~600s observer window.

function writeState(path, state) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

function readState(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid run ID");
  return JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8"));
}

function workerAlive(state) {
  try {
    // Start ticks distinguish a reused PID from the original worker.
    const raw = readFileSync(`/proc/${state.pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] !== "Z" && fields[19] === state.startTicks;
  } catch {
    return false;
  }
}

function startTicks(pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
}

function status(id) {
  const state = readState(id);
  if (state.status === "RUNNING" && !workerAlive(state)) {
    console.error(`[observe-validation] ERROR ${id}: worker disappeared without terminal evidence; log: ${state.log}`);
    return 1;
  }
  console.log(`[observe-validation] ${state.status} ${id}: ${state.command.join(" ")}; log: ${state.log}`);
  if (state.status === "RUNNING") return 75;
  console.log(`[observe-validation] exit=${state.exitCode} signal=${state.signal ?? "none"} completed=${state.completedAt}`);
  return state.exitCode === 0 && state.status === "PASSED" ? 0 : state.exitCode || 1;
}

async function worker(id, command) {
  const path = join(stateDir, `${id}.json`);
  // The detached worker may be scheduled before its launcher publishes state.
  let state;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      state = readState(id);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (!state) throw new Error("launcher did not publish run state");
  const logFd = openSync(state.log, "a", 0o600);
  let child;
  let interrupted = null;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: root,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => {
        interrupted = signal;
        try { process.kill(-child.pid, signal); } catch { /* already exited */ }
      });
    }
    const result = await new Promise((done) => {
      child.once("error", (error) => done({ code: 1, error: error.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    });
    const exitCode = interrupted || result.signal ? 1 : result.code ?? 1;
    writeState(path, {
      ...state,
      status: exitCode === 0 ? "PASSED" : "FAILED",
      exitCode,
      signal: interrupted ?? result.signal ?? null,
      error: result.error ?? null,
      completedAt: new Date().toISOString(),
    });
  } finally {
    closeSync(logFd);
  }
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (mode === "status") return status(args[0]);
  if (mode === "worker") {
    const separator = args.indexOf("--");
    if (separator < 0 || separator === args.length - 1) throw new Error("worker command missing");
    await worker(args[0], args.slice(separator + 1));
    return 0;
  }
  if (mode !== "start") throw new Error("expected start or status");
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) throw new Error("command missing");
  const options = args.slice(0, separator);
  const waitMs = options.length === 0 ? MAX_WAIT_MS : Number(options[1]);
  if (options.length && (options.length !== 2 || options[0] !== "--wait-ms")) throw new Error("invalid start options");
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) throw new Error("invalid wait duration");
  const command = args.slice(separator + 1);
  const id = randomUUID();
  const log = join(stateDir, `${id}.log`);
  // The worker owns the command, not the service's process group. Never report
  // a pass until its terminal evidence is present.
  const fd = openSync(log, "wx", 0o600);
  closeSync(fd);
  const child = spawn(process.execPath, [self, "worker", id, "--", ...command], {
    cwd: root,
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  const path = join(stateDir, `${id}.json`);
  try {
    writeState(path, {
      id, pid: child.pid, startTicks: startTicks(child.pid), status: "RUNNING",
      command, log, startedAt: new Date().toISOString(),
    });
  } catch (error) {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* child already exited */ }
    throw error;
  }
  child.unref();
  console.log(`[observe-validation] started ${id}; check later with: node scripts/observe-validation.mjs status ${id}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, Math.min(1000, deadline - Date.now())));
    const state = readState(id);
    if (state.status !== "RUNNING" || !workerAlive(state)) return status(id);
  }
  console.error(`[observe-validation] PENDING ${id}: service observation window ended; run is still active. ` +
    `Check terminal evidence with: node scripts/observe-validation.mjs status ${id}`);
  return 75;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[observe-validation] ERROR: ${error.message}`);
  process.exitCode = 1;
});