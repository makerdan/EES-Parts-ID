#!/usr/bin/env node
/**
 * Deterministic black-box tests for the validation lock and port cleanup
 * recovery contracts. These tests intentionally run the production scripts in
 * child processes instead of importing implementation details.
 */
import {
  accessSync,
  chmodSync,
  existsSync,
  copyFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { getValidationHostTools } from "./validation-steps.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SERIAL_LOCK = join(ROOT, "scripts", "serial-lock.mjs");
const FREE_PORTS = join(ROOT, "scripts", "free-ports.mjs");
const PORT_CHECK = join(ROOT, "scripts", "check-hardcoded-ports.sh");
const SLEEP_CODE = "setTimeout(() => process.exit(0), Number(process.argv[1]))";
const MARK_CODE =
  "require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')";
const EXCLUSIVE_MARK_CODE = [
  "const fs = require('node:fs');",
  "const guard = process.argv[1];",
  "const marker = process.argv[2];",
  "const label = process.argv[3];",
  "let fd;",
  "try { fd = fs.openSync(guard, 'wx'); }",
  "catch { fs.appendFileSync(marker, 'OVERLAP\\n'); process.exit(9); }",
  "fs.appendFileSync(marker, label + ':start\\n');",
  "setTimeout(() => {",
  "  fs.closeSync(fd);",
  "  fs.rmSync(guard, { force: true });",
  "  fs.appendFileSync(marker, label + ':end\\n');",
  "}, 150);",
].join("");
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
    SERIAL_LOCK_QUEUE_DIR: join(testRoot, "queues", basename(lockFile, ".lock")),
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
  return join(testRoot, "queues", resource);
}

function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the host PATH.
    }
  }
  throw new Error(`could not resolve required host utility "${name}"`);
}

function createIsolatedValidationPath(omittedTool) {
  const isolatedPath = join(testRoot, `isolated-path-${omittedTool}`);
  mkdirSync(isolatedPath, { recursive: true });
  const hostPath = process.env.PATH ?? "";
  for (const requirement of getValidationHostTools("fast")) {
    if (requirement.name === omittedTool) continue;
    const wrapperPath = join(isolatedPath, requirement.name);
    const executable = findExecutable(requirement.name);
    writeFileSync(
      wrapperPath,
      [
        `#!${process.execPath}`,
        "const { spawnSync } = require('node:child_process');",
        `const result = spawnSync(${JSON.stringify(executable)}, process.argv.slice(2), {`,
        "  stdio: 'inherit',",
        `  env: { ...process.env, PATH: ${JSON.stringify(hostPath)} },`,
        "});",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"),
    );
    chmodSync(wrapperPath, 0o755);
  }
  return isolatedPath;
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

await test("serial lock rejects priorities outside the documented 1-9 scale", async () => {
  const resource = uniqueName("invalid-priority");
  const lockFile = join(testRoot, `${resource}.lock`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 10, [process.execPath, "-e", SLEEP_CODE, "1"]),
    lockEnv(lockFile),
  );
  assert(result.code === 2, `invalid priority exited ${result.code}: ${result.output}`);
  assert(result.output.includes("expected an integer from 1 to 9"), `missing priority diagnostic: ${result.output}`);
});

await test("serial lock fails closed with an actionable diagnostic when flock is unavailable", async () => {
  const resource = uniqueName("missing-flock");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "should-not-run",
    ]),
    lockEnv(lockFile, { PATH: "" }),
  );
  assert(result.code !== 0, `missing-flock wrapper unexpectedly succeeded: ${result.output}`);
  assert(
    result.output.includes(`flock utility is unavailable for the ${resource} serialization path`),
    `missing actionable flock diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes("refusing to fall back to an unsafe lock implementation"),
    `missing fail-closed diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "wrapped command ran without the flock guard");
  assert(!existsSync(lockFile), "missing-flock failure created a lock file");
});

await test("serial lock fails closed when flock disappears during acquisition", async () => {
  const resource = uniqueName("flock-race");
  const lockFile = join(testRoot, `${resource}.lock`);
  const guardFile = `${lockFile}.guard`;
  const queueDir = queueDirFor(resource);
  const marker = join(testRoot, `${resource}.marker`);
  const flockShimDir = join(testRoot, `${resource}-bin`);
  const flockShim = join(flockShimDir, "flock");
  mkdirSync(flockShimDir, { recursive: true });
  writeFileSync(
    flockShim,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      `  ${process.execPath} -e 'require("node:fs").unlinkSync(${JSON.stringify(flockShim)})'`,
      "  exit 0",
      "fi",
      "exit 127",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "should-not-run",
    ]),
    lockEnv(lockFile, {
      PATH: flockShimDir,
    }),
  );
  assert(result.code !== 0, `flock-race wrapper unexpectedly succeeded: ${result.output}`);
  assert(
    result.output.includes(`flock utility is unavailable for the ${resource} serialization path`),
    `missing mid-run flock diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes("refusing to fall back to an unsafe lock implementation"),
    `missing mid-run fail-closed diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "wrapped command ran after flock disappeared");
  assert(!existsSync(lockFile), "flock-race failure created a lock file");
  assert(!existsSync(guardFile), "flock-race failure left a guard file");
  assert(!existsSync(join(queueDir, `${result.child.pid}.json`)), "flock-race failure left a queue entry");
});

await test("validation preflight reports every missing host tool before queueing", async () => {
  const resource = "validation";
  const lockFile = join(testRoot, `${resource}-preflight.lock`);
  const queueDir = join(testRoot, "queues", "validation-preflight");
  const marker = join(testRoot, `${resource}-preflight.marker`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "should-not-run",
    ]),
    lockEnv(lockFile, {
      PATH: "",
      SERIAL_LOCK_QUEUE_DIR: queueDir,
      VALIDATION_TIER: "fast",
    }),
  );
  assert(result.code === 2, `validation preflight exited ${result.code}: ${result.output}`);
  for (const tool of ["node", "pnpm", "bash", "git", "flock"]) {
    assert(
      result.output.includes(`[validation-preflight] - ${tool}:`),
      `missing ${tool} preflight diagnostic: ${result.output}`,
    );
  }
  assert(
    result.output.includes("serialized validation, codegen, test, and port-guard steps"),
    `missing affected-capability diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes("setup source: the host util-linux package"),
    `missing setup-source diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes("Refusing to queue validation or use an unsafe fallback"),
    `missing fail-closed preflight diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "validation child ran despite failed preflight");
  assert(!existsSync(lockFile), "validation preflight created a lock file");
  assert(!existsSync(queueDir), "validation preflight created a queue entry");
});

await test("validation preflight reports one missing host tool before queueing", async () => {
  const resource = "validation";
  const lockFile = join(testRoot, `${resource}-single-preflight.lock`);
  const queueDir = join(testRoot, "queues", "validation-single-preflight");
  const marker = join(testRoot, `${resource}-single-preflight.marker`);
  const isolatedPath = createIsolatedValidationPath("git");
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "should-not-run",
    ]),
    lockEnv(lockFile, {
      PATH: isolatedPath,
      SERIAL_LOCK_QUEUE_DIR: queueDir,
      VALIDATION_TIER: "fast",
    }),
  );
  assert(result.code === 2, `single-tool validation preflight exited ${result.code}: ${result.output}`);
  assert(
    result.output.includes("[validation-preflight] ERROR: 1 required host tool(s) are unavailable for fast validation."),
    `missing single-tool count diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes(
      "[validation-preflight] - git: public repository boundary and history checks; " +
      "setup source: the host Git package;",
    ),
    `missing affected capability/setup diagnostic: ${result.output}`,
  );
  for (const tool of ["node", "pnpm", "bash", "flock"]) {
    assert(
      !result.output.includes(`[validation-preflight] - ${tool}:`),
      `unexpected missing-tool diagnostic for ${tool}: ${result.output}`,
    );
  }
  assert(!existsSync(marker), "validation child ran despite failed single-tool preflight");
  assert(!existsSync(lockFile), "single-tool validation preflight created a lock file");
  assert(!existsSync(queueDir), "single-tool validation preflight created a queue entry");
});

await test("standard-plus preflight includes post-merge host tools", async () => {
  const resource = "validation";
  const lockFile = join(testRoot, `${resource}-standard-plus.lock`);
  const queueDir = join(testRoot, "queues", "validation-standard-plus");
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "scripts/run-tier.mjs",
      "standard-plus",
      "--allow-no-plan",
    ]),
    lockEnv(lockFile, {
      PATH: "",
      SERIAL_LOCK_QUEUE_DIR: queueDir,
    }),
  );
  assert(result.code === 2, `standard-plus preflight exited ${result.code}: ${result.output}`);
  for (const tool of ["curl", "timeout"]) {
    assert(
      result.output.includes(`[validation-preflight] - ${tool}:`),
      `missing standard-plus ${tool} diagnostic: ${result.output}`,
    );
  }
  assert(!existsSync(lockFile), "standard-plus preflight created a lock file");
  assert(!existsSync(queueDir), "standard-plus preflight created a queue entry");
});

await test("port cleanup rejects a missing port argument", async () => {
  const result = await runProcess(process.execPath, [FREE_PORTS]);
  assert(result.code === 2, `missing-port cleanup exited ${result.code}: ${result.output}`);
  assert(result.output.includes("Usage: free-ports.mjs"), `missing usage diagnostic: ${result.output}`);
});

await test("port cleanup leaves an unused ephemeral port untouched", async () => {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  const result = await runProcess(process.execPath, [FREE_PORTS, String(port)]);
  assert(result.code === 0, `unused-port cleanup exited ${result.code}: ${result.output}`);
  assert(!result.output.includes("terminating tree"), `unused port was treated as occupied: ${result.output}`);
});

await test("serial lock propagates child status and removes the lock", async () => {
  for (const exitCode of [0, 7]) {
    const resource = uniqueName(`child-exit-${exitCode}`);
    const lockFile = join(testRoot, `${resource}.lock`);
    const result = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 2, [process.execPath, "-e", `process.exit(${exitCode})`]),
      lockEnv(lockFile),
    );
    assert(result.code === exitCode, `child exit ${exitCode} became ${result.code}: ${result.output}`);
    assert(!existsSync(lockFile), `lock remained after child exit ${exitCode}`);
    assert(!existsSync(join(queueDirFor(resource), `${result.child.pid}.json`)), `queue entry remained after child exit ${exitCode}`);
  }
});

await test("serial lock honors priority-aware queue ordering", async () => {
  const resource = uniqueName("priority");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.order`);
  const queueDir = queueDirFor(resource);
  const graceEnv = { SERIAL_LOCK_PRIORITY_GRACE_MS: "50" };
  const holder = spawnLock(resource, lockFile, 5, [process.execPath, "-e", SLEEP_CODE, "350"], graceEnv);
  try {
    await waitFor(() => existsSync(lockFile), "priority holder lock");
    const low = spawnLock(resource, lockFile, 9, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "low",
    ], graceEnv);
    await waitFor(
      () => existsSync(join(queueDir, `${low.child.pid}.json`)),
      "low-priority queue entry",
    );
    const high = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "high",
    ], graceEnv);
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

await test("serial lock preserves FIFO order before the priority grace expires", async () => {
  const resource = uniqueName("priority-grace");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.order`);
  const queueDir = queueDirFor(resource);
  const graceEnv = { SERIAL_LOCK_PRIORITY_GRACE_MS: "1000" };
  const holder = spawnLock(resource, lockFile, 5, [process.execPath, "-e", SLEEP_CODE, "300"], graceEnv);
  try {
    await waitFor(() => existsSync(lockFile), "grace holder lock");
    const low = spawnLock(resource, lockFile, 9, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "low",
    ], graceEnv);
    await waitFor(() => existsSync(join(queueDir, `${low.child.pid}.json`)), "older low-priority waiter");
    const high = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "high",
    ], graceEnv);
    await waitFor(() => existsSync(join(queueDir, `${high.child.pid}.json`)), "newer high-priority waiter");
    const [holderResult, lowResult, highResult] = await Promise.all([
      holder.result,
      low.result,
      high.result,
    ]);
    assert(holderResult.code === 0, `grace holder exited ${holderResult.code}`);
    assert(lowResult.code === 0, `older waiter exited ${lowResult.code}: ${lowResult.output}`);
    assert(highResult.code === 0, `newer waiter exited ${highResult.code}: ${highResult.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "low\nhigh",
      `expected low then high before grace, got ${JSON.stringify(readFileSync(marker, "utf8"))}`,
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
  const staleTemp = join(queueDir, "987654321.json.old-start.tmp");
  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      staleQueue,
      JSON.stringify({ pid: 987654321, priority: 999, queuedAt: Date.now() - 60000, startTicks: "old" }),
    );
    writeFileSync(staleTemp, "incomplete publication");
    setMtime(staleTemp, Date.now() - 60000);
    const result = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "1"]),
      lockEnv(lockFile),
    );
    assert(result.code === 0, `waiter exited ${result.code}: ${result.output}`);
    assert(!existsSync(staleQueue), "stale queue entry was not removed");
    assert(!existsSync(staleTemp), "stale queue publication temp was not removed");
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
      const diagnostics = result.output
        .split("\n")
        .filter((line) => line.includes("forcibly reclaiming") || line.includes("reclaiming stale lock"))
        .join(" | ");
      console.log(`  recovery diagnostics: ${diagnostics}`);
    } finally {
      rmSync(queueDirFor(resource), { recursive: true, force: true });
    }
  });
}

await test("serial lock serializes concurrent stale-lock reclaimers", async () => {
  const resource = uniqueName("concurrent-reclaim");
  const lockFile = join(testRoot, `${resource}.lock`);
  const guard = join(testRoot, `${resource}.guard`);
  const marker = join(testRoot, `${resource}.order`);
  try {
    writeLock(lockFile, { pid: 987654321, acquiredAt: Date.now() });
    const first = spawnLock(resource, lockFile, 9, [
      process.execPath,
      "-e",
      EXCLUSIVE_MARK_CODE,
      guard,
      marker,
      "first",
    ], { SERIAL_LOCK_PRIORITY_GRACE_MS: "0" });
    const second = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      EXCLUSIVE_MARK_CODE,
      guard,
      marker,
      "second",
    ], { SERIAL_LOCK_PRIORITY_GRACE_MS: "0" });
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    assert(firstResult.code === 0, `first reclaimer exited ${firstResult.code}: ${firstResult.output}`);
    assert(secondResult.code === 0, `second reclaimer exited ${secondResult.code}: ${secondResult.output}`);
    const lines = readFileSync(marker, "utf8").trim().split("\n");
    assert(!lines.includes("OVERLAP"), `concurrent holders overlapped: ${JSON.stringify(lines)}`);
    assert(lines.length === 4, `expected two serialized child spans, got ${JSON.stringify(lines)}`);
    assert(lines[0].endsWith(":start") && lines[1] === lines[0].replace(":start", ":end"), `first span was not serialized: ${JSON.stringify(lines)}`);
    assert(lines[2].endsWith(":start") && lines[3] === lines[2].replace(":start", ":end"), `second span was not serialized: ${JSON.stringify(lines)}`);
  } finally {
    rmSync(guard, { force: true });
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

await test("serial lock starts the resource budget after queue acquisition", async () => {
  const resource = uniqueName("budget");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const holder = spawnLock(resource, lockFile, 1, [process.execPath, "-e", SLEEP_CODE, "800"]);
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
      lockEnv(lockFile, { SERIAL_LOCK_BUDGET_MS: "500" }),
      5000,
    );
    const holderResult = await holder.result;
    assert(holderResult.code === 0, `budget holder exited ${holderResult.code}`);
    assert(waiter.code === 0, `budget waiter exited ${waiter.code}: ${waiter.output}`);
    assert(readFileSync(marker, "utf8").trim() === "acquired", "waiter never ran after acquiring");
    assert(!waiter.output.includes("budget of 500ms exceeded"), `budget included queue wait: ${waiter.output}`);
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

await test("fast port check rejects artifact manifest drift", async () => {
  const fixtureRoot = join(testRoot, "manifest-drift-fixture");
  for (const artifact of ["parts-id", "api-server", "mockup-sandbox"]) {
    const source = join(ROOT, "artifacts", artifact, ".replit-artifact", "artifact.toml");
    const target = join(fixtureRoot, artifact, ".replit-artifact", "artifact.toml");
    mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(source, target);
  }

  const apiManifest = join(fixtureRoot, "api-server", ".replit-artifact", "artifact.toml");
  writeFileSync(apiManifest, readFileSync(apiManifest, "utf8").replace("localPort = 3001", "localPort = 3999"));

  const result = await runProcess(
    "bash",
    [PORT_CHECK],
    { ...process.env, PORT_CONTRACT_ARTIFACT_ROOT: fixtureRoot },
  );
  assert(result.code === 1, `drift fixture exited ${result.code}: ${result.output}`);
  assert(
    result.output.includes("API Server artifact manifest localPort drift: expected 3001, found 3999"),
    `missing actionable manifest drift diagnostic: ${result.output}`,
  );
});

rmSync(testRoot, { recursive: true, force: true });
const failed = results.filter((result) => !result.ok);
console.log(`Port Authority results: ${results.length - failed.length} passed, ${failed.length} failed.`);
process.exit(failed.length === 0 ? 0 : 1);