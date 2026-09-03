#!/usr/bin/env node
/**
 * Deterministic black-box tests for the validation lock and port cleanup
 * recovery contracts. These tests intentionally run the production scripts in
 * child processes instead of importing implementation details.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const SERIAL_LOCK = join(ROOT, "scripts", "serial-lock.mjs");
const FREE_PORTS = join(ROOT, "scripts", "free-ports.mjs");
const SLEEP_CODE = "setTimeout(() => process.exit(0), Number(process.argv[1]))";
const MARK_CODE =
  "require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')";
const SERVER_CODE = [
  "const net = require('node:net');",
  "const server = net.createServer();",
  "server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));",
  "setInterval(() => {}, 1000);",
].join("");

const testRoot = mkdtempSync(join(tmpdir(), "port-authority-"));
const results = [];

function uniqueName(label) {
  return `task987-${label}-${process.pid}-${results.length}`;
}

function lockEnv(lockFile, overrides = {}) {
  return {
    ...process.env,
    SERIAL_LOCK_FILE: lockFile,
    SERIAL_LOCK_POLL_MS: "10",
    SERIAL_LOCK_TIMEOUT_MS: "5000",
    SERIAL_LOCK_STALE_HEARTBEAT_MS: "10000",
    SERIAL_LOCK_MAX_HOLD_MS: "10000",
    SERIAL_LOCK_HELD_PID: "",
    SERIAL_LOCK_HELD_RESOURCES: "",
    ...overrides,
  };
}

function runProcess(command, args, env = process.env, timeoutMs = 7000) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      finish(124, "timeout");
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => finish(1, error.message));
    child.on("close", (code, signal) => finish(code ?? 1, signal ?? ""));

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ child, code, signal, output });
    }
  });
}

function lockArgs(resource, lockFile, priority, command) {
  return [
    SERIAL_LOCK,
    "--resource",
    resource,
    "--priority",
    String(priority),
    "--",
    ...command,
  ];
}

function queueDirFor(resource) {
  return join(ROOT, ".local", "serial-lock-queues", resource);
}

function spawnLock(resource, lockFile, priority, command, overrides = {}) {
  const child = spawn(process.execPath, lockArgs(resource, lockFile, priority, command), {
    cwd: ROOT,
    env: lockEnv(lockFile, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const result = new Promise((resolveResult) => {
    child.on("error", (error) => resolveResult({ child, code: 1, output: `${output}${error.message}` }));
    child.on("close", (code, signal) => resolveResult({ child, code: code ?? 1, signal, output }));
  });
  return { child, result };
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeLock(lockFile, { pid, acquiredAt, startTicks = "" }) {
  mkdirSync(resolve(lockFile, ".."), { recursive: true });
  writeFileSync(lockFile, `${pid}\n${acquiredAt}\n0\n${startTicks}\n`);
}

function setMtime(lockFile, mtimeMs) {
  const date = new Date(mtimeMs);
  utimesSync(lockFile, date, date);
}

async function test(name, callback) {
  try {
    await callback();
    results.push({ name, ok: true });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.error(`FAIL: ${name} — ${error.message}`);
  }
}

await test("serial lock honors priority-aware queue ordering", async () => {
  const resource = uniqueName("priority");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.order`);
  const queueDir = queueDirFor(resource);
  const holder = spawnLock(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "350"]);
  try {
    await waitFor(() => existsSync(lockFile), "priority holder lock");
    const low = spawnLock(resource, lockFile, 10, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "low",
    ]);
    await waitFor(
      () => existsSync(join(queueDir, `${low.child.pid}.json`)),
      "low-priority queue entry",
    );
    const high = spawnLock(resource, lockFile, 90, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "high",
    ]);
    const [holderResult, highResult, lowResult] = await Promise.all([
      holder.result,
      high.result,
      low.result,
    ]);
    assert(holderResult.code === 0, `holder exited ${holderResult.code}`);
    assert(highResult.code === 0, `high-priority waiter exited ${highResult.code}: ${highResult.output}`);
    assert(lowResult.code === 0, `low-priority waiter exited ${lowResult.code}: ${lowResult.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "high\nlow",
      `expected high then low, got ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
  } finally {
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    rmSync(queueDir, { recursive: true, force: true });
  }
});

await test("serial lock skips nested acquisition for a live holder", async () => {
  const resource = uniqueName("reentrant");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  try {
    const nested = lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "nested",
    ]);
    const outer = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [process.execPath, ...nested]),
      lockEnv(lockFile),
    );
    assert(outer.code === 0, `reentrant wrapper exited ${outer.code}: ${outer.output}`);
    assert(outer.output.includes("running reentrantly"), `missing reentrant log: ${outer.output}`);
    assert(readFileSync(marker, "utf8").trim() === "nested", "nested command did not run");
  } finally {
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

await test("serial lock removes stale queue entries before acquisition", async () => {
  const resource = uniqueName("stale-queue");
  const lockFile = join(testRoot, `${resource}.lock`);
  const queueDir = queueDirFor(resource);
  const staleQueue = join(queueDir, "987654321.json");
  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      staleQueue,
      JSON.stringify({ pid: 987654321, priority: 999, queuedAt: Date.now() - 60000, startTicks: "old" }),
    );
    const result = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "1"]),
      lockEnv(lockFile),
    );
    assert(result.code === 0, `waiter exited ${result.code}: ${result.output}`);
    assert(!existsSync(staleQueue), "stale queue entry was not removed");
  } finally {
    rmSync(queueDir, { recursive: true, force: true });
  }
});

const recoveryCases = [
  {
    label: "dead holder",
    reason: "dead or reused pid 987654321",
    pid: 987654321,
    acquiredAt: Date.now(),
    startTicks: "",
    mtimeMs: Date.now(),
  },
  {
    label: "PID reuse",
    reason: `dead or reused pid ${process.pid}`,
    pid: process.pid,
    acquiredAt: Date.now(),
    startTicks: "not-the-current-process-start-tick",
    mtimeMs: Date.now(),
  },
  {
    label: "stale heartbeat",
    reason: "heartbeat stale",
    pid: process.pid,
    acquiredAt: Date.now(),
    startTicks: "",
    mtimeMs: Date.now() - 60000,
  },
  {
    label: "max hold",
    reason: "max-hold safety valve",
    pid: process.pid,
    acquiredAt: Date.now() - 60000,
    startTicks: "",
    mtimeMs: Date.now(),
    maxHoldMs: "50",
  },
];

for (const recoveryCase of recoveryCases) {
  await test(`serial lock recovers and logs ${recoveryCase.label}`, async () => {
    const resource = uniqueName(recoveryCase.label.replaceAll(" ", "-"));
    const lockFile = join(testRoot, `${resource}.lock`);
    try {
      writeLock(lockFile, recoveryCase);
      setMtime(lockFile, recoveryCase.mtimeMs);
      const result = await runProcess(
        process.execPath,
        lockArgs(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "1"]),
        lockEnv(lockFile, {
          SERIAL_LOCK_MAX_HOLD_MS: recoveryCase.maxHoldMs ?? "10000",
        }),
      );
      assert(result.code === 0, `recovery exited ${result.code}: ${result.output}`);
      assert(result.output.includes("WARNING: forcibly reclaiming"), `missing warning: ${result.output}`);
      assert(result.output.includes(recoveryCase.reason), `missing ${recoveryCase.label} reason: ${result.output}`);
    } finally {
      rmSync(queueDirFor(resource), { recursive: true, force: true });
    }
  });
}

await test("serial lock starts the resource budget after queue acquisition", async () => {
  const resource = uniqueName("budget");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const holder = spawnLock(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "350"]);
  try {
    await waitFor(() => existsSync(lockFile), "budget holder lock");
    const waiter = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        `${MARK_CODE}; ${SLEEP_CODE}`,
        marker,
        "acquired",
        "20",
      ]),
      lockEnv(lockFile, { SERIAL_LOCK_BUDGET_MS: "100" }),
      5000,
    );
    const holderResult = await holder.result;
    assert(holderResult.code === 0, `budget holder exited ${holderResult.code}`);
    assert(waiter.code === 0, `budget waiter exited ${waiter.code}: ${waiter.output}`);
    assert(readFileSync(marker, "utf8").trim() === "acquired", "waiter never ran after acquiring");
    assert(!waiter.output.includes("budget of 100ms exceeded"), `budget included queue wait: ${waiter.output}`);
  } finally {
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

await test("port cleanup refuses to claim a protected active caller is cleared", async () => {
  const server = spawn(process.execPath, ["-e", SERVER_CODE], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  try {
    await waitFor(() => /PORT:\d+/.test(serverOutput), "descendant TCP listener");
    const port = Number(serverOutput.match(/PORT:(\d+)/)[1]);
    const result = await runProcess(process.execPath, [FREE_PORTS, String(port)]);
    assert(result.code === 1, `protected cleanup exited ${result.code}: ${result.output}`);
    assert(result.output.includes("refusing to claim port"), `missing protected refusal: ${result.output}`);
    assert(server.exitCode === null, "protected listener was terminated");
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    await new Promise((resolveServer) => server.once("close", resolveServer));
  }
});

rmSync(testRoot, { recursive: true, force: true });
const failed = results.filter((result) => !result.ok);
console.log(`Port Authority results: ${results.length - failed.length} passed, ${failed.length} failed.`);
process.exit(failed.length === 0 ? 0 : 1);