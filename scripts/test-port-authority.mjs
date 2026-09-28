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
  readdirSync,
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
const SERIAL_LOCK_CRITICAL = join(ROOT, "scripts", "serial-lock-critical.mjs");
const FREE_PORTS = join(ROOT, "scripts", "free-ports.mjs");
const PORT_CHECK = join(ROOT, "scripts", "check-hardcoded-ports.sh");
const SLEEP_CODE = "setTimeout(() => process.exit(0), Number(process.argv[1]))";
const MARK_CODE =
  "require('node:fs').appendFileSync(process.argv[1], process.argv[2] + '\\n')";
const MARK_AND_SLEEP_CODE = [
  "const fs = require('node:fs');",
  "fs.appendFileSync(process.argv[1], process.argv[2] + '\\n');",
  "setTimeout(() => process.exit(0), Number(process.argv[3]));",
].join("");
const EXCLUSIVE_MARK_CODE = [
  "const fs = require('node:fs');",
  "const guard = process.argv[1];",
  "const marker = process.argv[2];",
  "const label = process.argv[3];",
  "const duration = Number(process.argv[4] || 150);",
  "let fd;",
  "try { fd = fs.openSync(guard, 'wx'); }",
  "catch { fs.appendFileSync(marker, 'OVERLAP\\n'); process.exit(9); }",
  "fs.appendFileSync(marker, label + ':start\\n');",
  "setTimeout(() => {",
  "  fs.closeSync(fd);",
  "  fs.rmSync(guard, { force: true });",
  "  fs.appendFileSync(marker, label + ':end\\n');",
  "}, duration);",
].join("");
const SERVER_CODE = [
  "const net = require('node:net');",
  "const server = net.createServer();",
  "server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port));",
  "setInterval(() => {}, 1000);",
].join("");
const SIGNAL_IGNORING_TREE_CODE = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const marker = process.argv[1];",
  "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: false, stdio: 'ignore' });",
  "fs.writeFileSync(marker, `${process.pid}\\n${child.pid}\\n`);",
  "process.on('SIGTERM', () => {});",
  "setInterval(() => {}, 1000);",
].join("");
const RECOVERABLE_WORKER_CODE = [
  "const fs = require('node:fs');",
  "const pidFile = process.argv[1];",
  "const marker = process.argv[2];",
  "fs.writeFileSync(pidFile, String(process.pid));",
  "fs.appendFileSync(marker, 'old:start\\n');",
  "process.on('SIGTERM', () => { fs.appendFileSync(marker, 'old:term\\n'); process.exit(0); });",
  "setInterval(() => {}, 1000);",
].join("");
const RECOVERY_SUCCESSOR_CODE = [
  "const fs = require('node:fs');",
  "const oldPid = Number(fs.readFileSync(process.argv[1], 'utf8'));",
  "const marker = process.argv[2];",
  "try { process.kill(oldPid, 0); fs.appendFileSync(marker, 'OVERLAP\\n'); } catch {}",
  "fs.appendFileSync(marker, 'successor\\n');",
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

function criticalArgs(lockFile, resource, operation, token) {
  return [
    "--exclusive",
    join(testRoot, `${basename(lockFile, ".lock")}.guard`),
    process.execPath,
    SERIAL_LOCK_CRITICAL,
    lockFile,
    resource,
    "1",
    String(process.pid),
    "",
    "10000",
    "10000",
    operation,
    token,
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

function createIsolatedValidationPath({
  tier = "fast",
  omittedTool = null,
  failingTool = null,
  hangingTool = null,
} = {}) {
  const isolatedPath = join(
    testRoot,
    `isolated-path-${tier}-${omittedTool ?? "complete"}-${failingTool ?? "healthy"}`,
  );
  mkdirSync(isolatedPath, { recursive: true });
  const hostPath = process.env.PATH ?? "";
  for (const requirement of getValidationHostTools(tier)) {
    if (requirement.name === omittedTool) continue;
    const wrapperPath = join(isolatedPath, requirement.name);
    if (requirement.name === failingTool) {
      writeFileSync(wrapperPath, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
      continue;
    }
    if (requirement.name === hangingTool) {
      writeFileSync(wrapperPath, "#!/bin/sh\nwhile :; do :; done\n", { mode: 0o755 });
      continue;
    }
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
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

await test("serial lock rejects malformed execution budgets before queueing or child execution", async () => {
  for (const budget of ["", "not-a-number", "0", "-1", "1.5", "2147483648", "9007199254740992"]) {
    const resource = uniqueName(`invalid-budget-${budget || "empty"}`);
    const lockFile = join(testRoot, `${resource}.lock`);
    const queueDir = queueDirFor(resource);
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
      lockEnv(lockFile, {
        SERIAL_LOCK_BUDGET_MS: budget,
        SERIAL_LOCK_QUEUE_DIR: queueDir,
      }),
    );
    assert(result.code === 2, `invalid budget ${JSON.stringify(budget)} exited ${result.code}: ${result.output}`);
    assert(
      result.output.includes(`invalid SERIAL_LOCK_BUDGET_MS: ${JSON.stringify(budget)}`),
      `missing invalid-budget value diagnostic for ${JSON.stringify(budget)}: ${result.output}`,
    );
    assert(
      result.output.includes("expected a positive integer from 1 to 2147483647 milliseconds"),
      `missing invalid-budget correction for ${JSON.stringify(budget)}: ${result.output}`,
    );
    assert(
      result.output.includes("omit the variable for no execution budget"),
      `missing omitted-budget guidance for ${JSON.stringify(budget)}: ${result.output}`,
    );
    assert(!existsSync(marker), `child ran for invalid budget ${JSON.stringify(budget)}`);
    assert(!existsSync(lockFile), `lock was created for invalid budget ${JSON.stringify(budget)}`);
    assert(!existsSync(queueDir), `queue was created for invalid budget ${JSON.stringify(budget)}`);
  }
});

await test("serial lock rejects malformed timing settings before queueing or child execution", async () => {
  const timingSettings = [
    "SERIAL_LOCK_POLL_MS",
    "SERIAL_LOCK_TIMEOUT_MS",
    "SERIAL_LOCK_HEARTBEAT_MS",
    "SERIAL_LOCK_STALE_HEARTBEAT_MS",
    "SERIAL_LOCK_PRIORITY_GRACE_MS",
    "SERIAL_LOCK_MAX_HOLD_MS",
    "SERIAL_LOCK_KILL_GRACE_MS",
    "SERIAL_LOCK_GROUP_POLL_MS",
  ];
  for (const setting of timingSettings) {
    for (const value of ["", "not-a-number", "0", "-1", "1.5", "2147483648", "9007199254740992"]) {
      const resource = uniqueName(`invalid-${setting.toLowerCase()}-${value || "empty"}`);
      const lockFile = join(testRoot, `${resource}.lock`);
      const queueDir = queueDirFor(resource);
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
        lockEnv(lockFile, {
          [setting]: value,
          SERIAL_LOCK_QUEUE_DIR: queueDir,
        }),
      );
      assert(
        result.code === 2,
        `invalid ${setting} ${JSON.stringify(value)} exited ${result.code}: ${result.output}`,
      );
      assert(
        result.output.includes(`invalid ${setting}: ${JSON.stringify(value)}`),
        `missing invalid-setting value diagnostic for ${setting}=${JSON.stringify(value)}: ${result.output}`,
      );
      assert(
        result.output.includes("expected a positive integer from 1 to 2147483647 milliseconds"),
        `missing correction for ${setting}=${JSON.stringify(value)}: ${result.output}`,
      );
      assert(
        result.output.includes("omit the variable to use the documented default"),
        `missing default guidance for ${setting}=${JSON.stringify(value)}: ${result.output}`,
      );
      assert(!existsSync(marker), `child ran for invalid ${setting}=${JSON.stringify(value)}`);
      assert(!existsSync(lockFile), `lock was created for invalid ${setting}=${JSON.stringify(value)}`);
      assert(!existsSync(queueDir), `queue was created for invalid ${setting}=${JSON.stringify(value)}`);
    }
  }
});

await test("serial lock uses documented timing defaults when controls are omitted", async () => {
  const resource = uniqueName("omitted-timing-defaults");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const env = lockEnv(lockFile);
  for (const setting of [
    "SERIAL_LOCK_POLL_MS",
    "SERIAL_LOCK_TIMEOUT_MS",
    "SERIAL_LOCK_HEARTBEAT_MS",
    "SERIAL_LOCK_STALE_HEARTBEAT_MS",
    "SERIAL_LOCK_PRIORITY_GRACE_MS",
    "SERIAL_LOCK_MAX_HOLD_MS",
    "SERIAL_LOCK_KILL_GRACE_MS",
    "SERIAL_LOCK_GROUP_POLL_MS",
  ]) {
    delete env[setting];
  }
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "ran",
    ]),
    env,
  );
  assert(result.code === 0, `omitted timing settings exited ${result.code}: ${result.output}`);
  assert(readFileSync(marker, "utf8").trim() === "ran", "child did not run with timing defaults");
});

await test("serial lock accepts the maximum runtime timer budget", async () => {
  const resource = uniqueName("maximum-budget");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "ran",
    ]),
    lockEnv(lockFile, { SERIAL_LOCK_BUDGET_MS: "2147483647" }),
  );
  assert(result.code === 0, `maximum budget exited ${result.code}: ${result.output}`);
  assert(readFileSync(marker, "utf8").trim() === "ran", "maximum-budget child did not run");
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

await test("serial lock fails closed on an unexpected acquisition-helper exit", async () => {
  const resource = uniqueName("flock-unexpected-exit");
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
      "  exit 0",
      "fi",
      "exit 42",
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
      SERIAL_LOCK_QUEUE_DIR: queueDir,
    }),
  );
  assert(result.code !== 0, `unexpected-helper wrapper unexpectedly succeeded: ${result.output}`);
  assert(
    result.output.includes(`[serial-lock] acquisition helper exited 42`),
    `missing unexpected acquisition-helper diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "wrapped command ran after unexpected acquisition-helper failure");
  assert(!existsSync(lockFile), "unexpected-helper failure created a lock file");
  assert(!existsSync(guardFile), "unexpected-helper failure left a guard file");
  assert(
    !existsSync(queueDir) || readdirSync(queueDir).length === 0,
    "unexpected-helper failure left a queue entry",
  );
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
  const isolatedPath = createIsolatedValidationPath({ omittedTool: "git" });
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

await test("validation preflight reports one broken host-tool probe before queueing", async () => {
  const resource = "validation";
  const lockFile = join(testRoot, `${resource}-broken-preflight.lock`);
  const queueDir = join(testRoot, "queues", "validation-broken-preflight");
  const marker = join(testRoot, `${resource}-broken-preflight.marker`);
  const isolatedPath = createIsolatedValidationPath({ failingTool: "git" });
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
  assert(result.code === 2, `broken-tool validation preflight exited ${result.code}: ${result.output}`);
  assert(
    result.output.includes("[validation-preflight] ERROR: 1 required host tool(s) are unavailable for fast validation."),
    `missing broken-tool count diagnostic: ${result.output}`,
  );
  assert(
    result.output.includes(
      "[validation-preflight] - git: public repository boundary and history checks; " +
      "setup source: the host Git package; probe: probe exited 42.",
    ),
    `missing broken-tool capability/setup/probe diagnostic: ${result.output}`,
  );
  for (const tool of ["node", "pnpm", "bash", "flock"]) {
    assert(
      !result.output.includes(`[validation-preflight] - ${tool}:`),
      `unexpected broken-tool diagnostic for ${tool}: ${result.output}`,
    );
  }
  assert(!existsSync(marker), "validation child ran despite failed broken-tool preflight");
  assert(!existsSync(lockFile), "broken-tool preflight created a lock file");
  assert(!existsSync(queueDir), "broken-tool preflight created a queue entry");
});

await test("validation preflight bounds a hung host-tool probe before queueing", async () => {
  const resource = "validation";
  const lockFile = join(testRoot, `${resource}-hung-preflight.lock`);
  const queueDir = join(testRoot, "queues", "validation-hung-preflight");
  const marker = join(testRoot, `${resource}-hung-preflight.marker`);
  const isolatedPath = createIsolatedValidationPath({ hangingTool: "git" });
  const startedAt = Date.now();
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
  const elapsedMs = Date.now() - startedAt;
  assert(result.code === 2, `hung-tool validation preflight exited ${result.code}: ${result.output}`);
  assert(
    elapsedMs < 7000,
    `hung-tool validation preflight exceeded its outer bound (${elapsedMs}ms): ${result.output}`,
  );
  assert(
    result.output.includes(
      "[validation-preflight] - git: public repository boundary and history checks; " +
      "setup source: the host Git package; probe: probe timed out after 2000ms.",
    ),
    `missing hung-tool timeout diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "validation child ran despite hung-tool preflight");
  assert(!existsSync(lockFile), "hung-tool preflight created a lock file");
  assert(!existsSync(queueDir), "hung-tool preflight created a queue entry");
});

await test("serial lock bounds a hung flock capability probe before queueing", async () => {
  const resource = uniqueName("hung-flock");
  const lockFile = join(testRoot, `${resource}.lock`);
  const queueDir = queueDirFor(resource);
  const marker = join(testRoot, `${resource}.marker`);
  const isolatedPath = mkdtempSync(join(testRoot, "hung-flock-path-"));
  writeFileSync(
    join(isolatedPath, "flock"),
    "#!/bin/sh\nwhile :; do :; done\n",
    { mode: 0o755 },
  );
  const startedAt = Date.now();
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
    }),
  );
  const elapsedMs = Date.now() - startedAt;
  assert(result.code === 1, `hung-flock probe exited ${result.code}: ${result.output}`);
  assert(
    elapsedMs < 7000,
    `hung-flock probe exceeded its outer bound (${elapsedMs}ms): ${result.output}`,
  );
  assert(
    result.output.includes(
      "[serial-lock] ERROR: the flock utility is unavailable for the " +
      `${resource} serialization path (the capability probe timed out after 2000ms).`,
    ),
    `missing hung-flock timeout diagnostic: ${result.output}`,
  );
  assert(!existsSync(marker), "child command ran despite hung-flock probe");
  assert(!existsSync(lockFile), "hung-flock probe created a lock file");
  assert(!existsSync(queueDir), "hung-flock probe created a queue entry");
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

for (const {
  tier,
  tool,
  capability,
  setup,
} of [
  {
    tier: "standard-plus",
    tool: "curl",
    capability: "standard-plus post-merge health checks",
    setup: "the host curl package",
  },
  {
    tier: "heavy",
    tool: "timeout",
    capability: "standard-plus post-merge command time limits",
    setup: "the host coreutils package",
  },
]) {
  await test(`${tier} preflight reports one broken ${tool} probe before queueing`, async () => {
    const resource = "validation";
    const lockFile = join(testRoot, `${resource}-${tier}-broken-${tool}.lock`);
    const queueDir = join(testRoot, "queues", `${resource}-${tier}-broken-${tool}`);
    const marker = join(testRoot, `${resource}-${tier}-broken-${tool}.marker`);
    const isolatedPath = createIsolatedValidationPath({ tier, failingTool: tool });
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
        VALIDATION_TIER: tier,
      }),
    );
    assert(result.code === 2, `${tier} broken-${tool} preflight exited ${result.code}: ${result.output}`);
    assert(
      result.output.includes(
        `[validation-preflight] ERROR: 1 required host tool(s) are unavailable for ${tier} validation.`,
      ),
      `missing ${tier} broken-${tool} count diagnostic: ${result.output}`,
    );
    assert(
      result.output.includes(
        `[validation-preflight] - ${tool}: ${capability}; setup source: ${setup}; ` +
        "probe: probe exited 42.",
      ),
      `missing ${tier} broken-${tool} capability/setup/probe diagnostic: ${result.output}`,
    );
    for (const requirement of getValidationHostTools(tier)) {
      if (requirement.name === tool) continue;
      assert(
        !result.output.includes(`[validation-preflight] - ${requirement.name}:`),
        `unexpected ${tier} diagnostic for ${requirement.name}: ${result.output}`,
      );
    }
    assert(!existsSync(marker), `${tier} validation child ran despite failed ${tool} probe`);
    assert(!existsSync(lockFile), `${tier} broken-${tool} preflight created a lock file`);
    assert(!existsSync(queueDir), `${tier} broken-${tool} preflight created a queue entry`);
  });
}

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

await test("serial lock preserves normal worker stdout and stderr", async () => {
  const resource = uniqueName("worker-output");
  const lockFile = join(testRoot, `${resource}.lock`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 2, [
      process.execPath,
      "-e",
      'process.stdout.write("worker stdout\\n"); process.stderr.write("worker stderr\\n")',
    ]),
    lockEnv(lockFile),
  );
  assert(result.code === 0, `output worker exited ${result.code}: ${result.output}`);
  assert(result.output.includes("worker stdout"), `worker stdout was not preserved: ${result.output}`);
  assert(result.output.includes("worker stderr"), `worker stderr was not preserved: ${result.output}`);
  assert(!existsSync(lockFile), "output worker left the lock behind");
});

await test("serial lock drains large worker output after a caller pauses both pipes", async () => {
  const resource = uniqueName("paused-output");
  const lockFile = join(testRoot, `${resource}.lock`);
  const startedFile = join(testRoot, `${resource}.started`);
  const bytes = 2 * 1024 * 1024;
  const child = spawn(process.execPath, lockArgs(resource, lockFile, 2, [
    process.execPath,
    "-e",
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[1], 'started');",
      "Promise.all([",
      "  new Promise(resolve => process.stdout.write(Buffer.alloc(Number(process.argv[2]), 65), resolve)),",
      "  new Promise(resolve => process.stderr.write(Buffer.alloc(Number(process.argv[2]), 66), resolve)),",
      "]).then(() => process.exit(0));",
    ].join(""),
    startedFile,
    String(bytes),
  ]), {
    cwd: ROOT,
    env: lockEnv(lockFile),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.pause();
  child.stderr.pause();
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(startedFile), "paused-output worker start", 3000);
    await delay(200);
    assert(child.exitCode === null, "wrapper exited before its buffered output was consumed");
    const closed = new Promise((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    });
    child.stdout.resume();
    child.stderr.resume();
    const result = await Promise.race([closed, delay(6000).then(() => null)]);
    assert(result, "paused-output wrapper did not close after the caller resumed reading");
    assert(result.code === 0, `paused-output wrapper exited ${result.code}: ${stderr.slice(0, 200)}`);
    assert(stdout.endsWith("A".repeat(bytes)), `worker stdout was truncated: ${stdout.length} bytes`);
    assert(stderr === "B".repeat(bytes), `worker stderr was truncated: ${stderr.length} bytes`);
    assert(!existsSync(lockFile), "paused-output wrapper left the lock behind");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

await test("serial lock wrapper loss closes caller pipes within the recovery bound", async () => {
  const resource = uniqueName("wrapper-loss-pipes");
  const lockFile = join(testRoot, `${resource}.lock`);
  const pidFile = join(testRoot, `${resource}.pid`);
  const marker = join(testRoot, `${resource}.marker`);
  let holder;
  try {
    holder = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      RECOVERABLE_WORKER_CODE,
      pidFile,
      marker,
    ]);
    await waitFor(() => existsSync(pidFile), "wrapper-loss worker registration");
    holder.child.kill("SIGKILL");
    const observedAt = Date.now();
    const holderResult = await Promise.race([
      holder.result,
      delay(1000).then(() => null),
    ]);
    assert(holderResult, "wrapper-loss observation remained open after the wrapper exited");
    assert(holderResult.signal === "SIGKILL", `wrapper-loss signal was ${holderResult.signal}`);
    assert(Date.now() - observedAt < 1000, "wrapper-loss observation exceeded its recovery bound");

    const successor = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        RECOVERY_SUCCESSOR_CODE,
        pidFile,
        marker,
      ]),
      lockEnv(lockFile, {
        SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
        SERIAL_LOCK_POLL_MS: "10",
      }),
    );
    assert(successor.code === 0, `wrapper-loss successor exited ${successor.code}: ${successor.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "old:start\nold:term\nsuccessor",
      `wrapper-loss recovery overlapped the worker: ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
    assert(!existsSync(lockFile), "wrapper-loss recovery left the lock behind");
    assert(
      !existsSync(queueDirFor(resource)) || readdirSync(queueDirFor(resource)).length === 0,
      "wrapper-loss recovery left a queue entry",
    );
  } finally {
    if (holder?.child.exitCode === null) holder.child.kill("SIGKILL");
    rmSync(queueDirFor(resource), { recursive: true, force: true });
    rmSync(lockFile, { force: true });
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

await test("serial lock removes a terminated waiter without disturbing the holder", async () => {
  const resource = uniqueName("terminated-waiter");
  const lockFile = join(testRoot, `${resource}.lock`);
  const queueDir = queueDirFor(resource);
  const marker = join(testRoot, `${resource}.marker`);
  const holder = spawnLock(resource, lockFile, 1, [
    process.execPath,
    "-e",
    SLEEP_CODE,
    "350",
  ]);
  let waiter;
  let later;
  try {
    await waitFor(() => existsSync(lockFile), "termination holder lock");
    waiter = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "terminated",
    ]);
    await waitFor(() => existsSync(join(queueDir, `${waiter.child.pid}.json`)), "terminated waiter queue entry");

    waiter.child.kill("SIGTERM");
    const waiterResult = await waiter.result;
    assert(waiterResult.code === 1, `terminated waiter exited ${waiterResult.code}: ${waiterResult.output}`);
    assert(!existsSync(join(queueDir, `${waiter.child.pid}.json`)), "terminated waiter queue entry remained");
    assert(holder.child.exitCode === null, "terminating waiter disturbed the holder");

    later = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      MARK_CODE,
      marker,
      "later",
    ]);
    const [holderResult, laterResult] = await Promise.all([holder.result, later.result]);
    assert(holderResult.code === 0, `holder exited ${holderResult.code}: ${holderResult.output}`);
    assert(laterResult.code === 0, `later waiter exited ${laterResult.code}: ${laterResult.output}`);
    assert(readFileSync(marker, "utf8").trim() === "later", "terminated waiter command ran or later waiter did not run");
    assert(!existsSync(queueDir) || readdirSync(queueDir).length === 0, "abandoned queue state remained");
  } finally {
    if (waiter?.child.exitCode === null) waiter.child.kill("SIGKILL");
    if (later?.child.exitCode === null) later.child.kill("SIGKILL");
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

await test("serial lock refuses a token-mismatched release without removing ownership", async () => {
  const resource = uniqueName("token-mismatch");
  const lockFile = join(testRoot, `${resource}.lock`);
  const flock = findExecutable("flock");
  try {
    const acquired = await runProcess(
      flock,
      criticalArgs(lockFile, resource, "acquire", "original-token"),
    );
    assert(acquired.code === 0, `lock acquisition helper exited ${acquired.code}: ${acquired.output}`);
    const mismatchedRelease = await runProcess(
      flock,
      criticalArgs(lockFile, resource, "release", "successor-token"),
    );
    assert(mismatchedRelease.code === 5, `mismatched release exited ${mismatchedRelease.code}: ${mismatchedRelease.output}`);
    assert(existsSync(lockFile), "token-mismatched release removed ownership");
    const release = await runProcess(
      flock,
      criticalArgs(lockFile, resource, "release", "original-token"),
    );
    assert(release.code === 0, `original release exited ${release.code}: ${release.output}`);
    assert(!existsSync(lockFile), "original release left the lock behind");
  } finally {
    rmSync(lockFile, { force: true });
    rmSync(join(testRoot, `${resource}.guard`), { force: true });
  }
});

await test("serial lock recovers a lock when its release helper fails", async () => {
  const resource = uniqueName("release-failure");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const shimDir = join(testRoot, `${resource}-bin`);
  const realFlock = findExecutable("flock");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "flock");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "for arg in \"$@\"; do",
      "  if [ \"$arg\" = release ]; then exit 42; fi",
      "done",
      `exec ${JSON.stringify(realFlock)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const shimEnv = {
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
    SERIAL_LOCK_HEARTBEAT_MS: "10000",
  };
  try {
    const holder = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        MARK_AND_SLEEP_CODE,
        marker,
        "holder",
        "1",
      ]),
      lockEnv(lockFile, shimEnv),
    );
    assert(holder.code === 0, `release-failure holder exited ${holder.code}: ${holder.output}`);
    assert(holder.output.includes("could not release"), `missing release-failure warning: ${holder.output}`);
    assert(existsSync(lockFile), "failed release unexpectedly removed the lock");

    const successor = await runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        MARK_CODE,
        marker,
        "successor",
      ]),
      lockEnv(lockFile),
    );
    assert(successor.code === 0, `release-failure successor exited ${successor.code}: ${successor.output}`);
    assert(readFileSync(marker, "utf8").trim() === "holder\nsuccessor", "successor did not run after release recovery");
    assert(!existsSync(lockFile), "release-recovery successor left the lock behind");
  } finally {
    rmSync(queueDirFor(resource), { recursive: true, force: true });
    rmSync(lockFile, { force: true });
  }
});

await test("serial lock reclaims a killed wrapper's owned worker before successor execution", async () => {
  const resource = uniqueName("crashed-worker");
  const lockFile = join(testRoot, `${resource}.lock`);
  const pidFile = join(testRoot, `${resource}.pid`);
  const marker = join(testRoot, `${resource}.marker`);
  let holder;
  try {
    holder = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      RECOVERABLE_WORKER_CODE,
      pidFile,
      marker,
    ]);
    await waitFor(() => existsSync(pidFile), "crashed wrapper worker registration");
    holder.child.kill("SIGKILL");

    const successor = runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        RECOVERY_SUCCESSOR_CODE,
        pidFile,
        marker,
      ]),
      lockEnv(lockFile, {
        SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
        SERIAL_LOCK_POLL_MS: "10",
      }),
    );
    const holderResult = await holder.result;
    const successorResult = await successor;
    assert(holderResult.signal === "SIGKILL", `wrapper was not killed: ${holderResult.signal}`);
    assert(successorResult.code === 0, `successor exited ${successorResult.code}: ${successorResult.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "old:start\nold:term\nsuccessor",
      `successor overlapped or failed to recover the worker: ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
    assert(!existsSync(lockFile), "crashed-worker lock remained after successor completion");
    assert(
      !existsSync(queueDirFor(resource)) || readdirSync(queueDirFor(resource)).length === 0,
      "crashed-worker queue remained",
    );
  } finally {
    if (holder?.child.exitCode === null) holder.child.kill("SIGKILL");
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

await test("serial lock reclaims a stale-heartbeat worker group before successor execution", async () => {
  const resource = uniqueName("stale-worker");
  const lockFile = join(testRoot, `${resource}.lock`);
  const pidFile = join(testRoot, `${resource}.pid`);
  const marker = join(testRoot, `${resource}.marker`);
  let holder;
  try {
    holder = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      RECOVERABLE_WORKER_CODE,
      pidFile,
      marker,
    ], {
      SERIAL_LOCK_HEARTBEAT_MS: "10000",
      SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
    });
    await waitFor(() => existsSync(pidFile), "stale-heartbeat worker registration");

    const successor = runProcess(
      process.execPath,
      lockArgs(resource, lockFile, 1, [
        process.execPath,
        "-e",
        RECOVERY_SUCCESSOR_CODE,
        pidFile,
        marker,
      ]),
      lockEnv(lockFile, {
        SERIAL_LOCK_STALE_HEARTBEAT_MS: "50",
        SERIAL_LOCK_POLL_MS: "10",
      }),
    );
    const [holderResult, successorResult] = await Promise.all([holder.result, successor]);
    assert(holderResult.code === 0, `stale-heartbeat holder exited ${holderResult.code}: ${holderResult.output}`);
    assert(successorResult.code === 0, `stale-heartbeat successor exited ${successorResult.code}: ${successorResult.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "old:start\nold:term\nsuccessor",
      `stale-heartbeat successor overlapped the worker: ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
    assert(!existsSync(lockFile), "stale-heartbeat lock remained after recovery");
  } finally {
    if (holder?.child.exitCode === null) holder.child.kill("SIGKILL");
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

await test("serial lock bounds repeated crash recovery and preserves priority fairness", async () => {
  const resource = uniqueName("repeated-recovery");
  const lockFile = join(testRoot, `${resource}.lock`);
  const guard = join(testRoot, `${resource}.guard`);
  const marker = join(testRoot, `${resource}.order`);
  const recoveryModes = ["crash", "stale", "crash", "stale"];
  const successorDefinitions = [
    { priority: 3, name: "low" },
    { priority: 1, name: "high" },
    { priority: 2, name: "middle" },
  ];
  const expected = [];
  const holders = [];
  try {
    for (const [round, mode] of recoveryModes.entries()) {
      const pidFile = join(testRoot, `${resource}-${round}.pid`);
      const workerMarker = join(testRoot, `${resource}-${round}.worker`);
      const staleHeartbeatMs = mode === "crash" ? "10000" : "100";
      const holder = spawnLock(resource, lockFile, 1, [
        process.execPath,
        "-e",
        RECOVERABLE_WORKER_CODE,
        pidFile,
        workerMarker,
      ], {
        SERIAL_LOCK_HEARTBEAT_MS: "10000",
        SERIAL_LOCK_STALE_HEARTBEAT_MS: staleHeartbeatMs,
        SERIAL_LOCK_PRIORITY_GRACE_MS: "20",
      });
      holders.push(holder);
      await waitFor(() => existsSync(pidFile), `${mode} round ${round} worker registration`);
      await waitFor(() => existsSync(lockFile), `${mode} round ${round} lock`);

      const successors = successorDefinitions.map(({ priority, name }) =>
        spawnLock(resource, lockFile, priority, [
          process.execPath,
          "-e",
          EXCLUSIVE_MARK_CODE,
          guard,
          marker,
          `round${round}:${name}`,
          "30",
        ], {
          SERIAL_LOCK_STALE_HEARTBEAT_MS: staleHeartbeatMs,
          SERIAL_LOCK_PRIORITY_GRACE_MS: "20",
          SERIAL_LOCK_POLL_MS: "10",
        }),
      );
      await waitFor(
        () =>
          existsSync(queueDirFor(resource)) &&
          readdirSync(queueDirFor(resource)).filter((entry) => entry.endsWith(".json")).length >= 3,
        `${mode} round ${round} queue`,
      );
      await delay(150);
      if (mode === "crash") holder.child.kill("SIGKILL");

      const successorResults = await Promise.all(successors.map(({ result }) => result));
      const holderResult = await holder.result;
      assert(
        mode === "crash" ? holderResult.signal === "SIGKILL" : holderResult.code === 0,
        `${mode} round ${round} holder ended unexpectedly: ${JSON.stringify(holderResult)}`,
      );
      for (const [index, result] of successorResults.entries()) {
        assert(
          result.code === 0,
          `${mode} round ${round} successor ${successorDefinitions[index].name} exited ${result.code}: ${result.output}; ` +
          `all successors: ${JSON.stringify(successorResults.map(({ code, signal, output }) => ({ code, signal, output })))}; ` +
          `lock exists: ${existsSync(lockFile)}; queue: ${
            existsSync(queueDirFor(resource)) ? readdirSync(queueDirFor(resource)).join(",") : "<missing>"
          }`,
        );
      }
      expected.push(
        `round${round}:high:start`,
        `round${round}:high:end`,
        `round${round}:middle:start`,
        `round${round}:middle:end`,
        `round${round}:low:start`,
        `round${round}:low:end`,
      );
      assert(!existsSync(lockFile), `${mode} round ${round} left the lock behind`);
      assert(
        !existsSync(queueDirFor(resource)) || readdirSync(queueDirFor(resource)).length === 0,
        `${mode} round ${round} left queue state behind`,
      );
      rmSync(pidFile, { force: true });
    }

    assert(
      !readFileSync(marker, "utf8").includes("OVERLAP"),
      `repeated recovery allowed exclusive workers to overlap: ${readFileSync(marker, "utf8")}`,
    );
    assert(
      readFileSync(marker, "utf8").trim() === expected.join("\n"),
      `repeated recovery lost documented priority order: ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
  } finally {
    for (const holder of holders) {
      if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
    }
    rmSync(guard, { force: true });
    rmSync(lockFile, { force: true });
    rmSync(queueDirFor(resource), { recursive: true, force: true });
  }
});

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
    ], { SERIAL_LOCK_PRIORITY_GRACE_MS: "1" });
    const second = spawnLock(resource, lockFile, 1, [
      process.execPath,
      "-e",
      EXCLUSIVE_MARK_CODE,
      guard,
      marker,
      "second",
    ], { SERIAL_LOCK_PRIORITY_GRACE_MS: "1" });
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

await test("serial lock will not reclaim a live max-hold owner", async () => {
  const resource = uniqueName("live-max-hold");
  const lockFile = join(testRoot, `${resource}.lock`);
  const guard = join(testRoot, `${resource}.guard`);
  const marker = join(testRoot, `${resource}.marker`);
  const command = [process.execPath, "-e", EXCLUSIVE_MARK_CODE, guard, marker];
  const holder = spawnLock(resource, lockFile, 1, [...command, "holder", "1000"], {
    SERIAL_LOCK_MAX_HOLD_MS: "50",
  });
  let waiter;
  try {
    await waitFor(() => existsSync(lockFile), "live max-hold owner lock");
    waiter = spawnLock(resource, lockFile, 1, [...command, "waiter", "1000"], {
      SERIAL_LOCK_MAX_HOLD_MS: "50",
    });
    const [holderResult, waiterResult] = await Promise.all([holder.result, waiter.result]);
    assert(holderResult.code === 0, `live max-hold holder exited ${holderResult.code}: ${holderResult.output}`);
    assert(waiterResult.code === 0, `live max-hold waiter exited ${waiterResult.code}: ${waiterResult.output}`);
    assert(
      readFileSync(marker, "utf8").trim() === "holder:start\nholder:end\nwaiter:start\nwaiter:end",
      `live max-hold recovery overlapped the holder: ${JSON.stringify(readFileSync(marker, "utf8"))}`,
    );
  } finally {
    if (waiter?.child.exitCode === null) waiter.child.kill("SIGKILL");
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
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

await test("serial lock lets a completed child report success before its outer budget expires", async () => {
  const resource = uniqueName("completion-before-budget");
  const lockFile = join(testRoot, `${resource}.lock`);
  const marker = join(testRoot, `${resource}.marker`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      `${MARK_CODE}; ${SLEEP_CODE}`,
      marker,
      "completed",
      "100",
    ]),
    lockEnv(lockFile, { SERIAL_LOCK_BUDGET_MS: "500" }),
    5000,
  );
  assert(result.code === 0, `completed child was mistaken for a timeout: ${result.output}`);
  assert(readFileSync(marker, "utf8").trim() === "completed", "completed child did not publish its result");
  assert(!result.output.includes("budget of 500ms exceeded"), "outer budget fired after the child completed");
  assert(!existsSync(lockFile), "lock remained after successful completion");
});

await test("serial lock budget kills signal-ignoring descendants before releasing the lock", async () => {
  const resource = uniqueName("budget-process-group");
  const lockFile = join(testRoot, `${resource}.lock`);
  const pidFile = join(testRoot, `${resource}.pids`);
  const result = await runProcess(
    process.execPath,
    lockArgs(resource, lockFile, 1, [
      process.execPath,
      "-e",
      SIGNAL_IGNORING_TREE_CODE,
      pidFile,
    ]),
    lockEnv(lockFile, {
      SERIAL_LOCK_BUDGET_MS: "100",
      SERIAL_LOCK_KILL_GRACE_MS: "50",
      SERIAL_LOCK_GROUP_POLL_MS: "10",
    }),
    5000,
  );
  assert(result.code === 124, `budget timeout must be nonzero timeout status: ${result.code}: ${result.output}`);
  assert(result.output.includes("terminating process group"), `missing process-group timeout diagnostic: ${result.output}`);
  const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
  assert(pids.length === 2, `timeout fixture recorded ${pids.length} processes instead of two`);
  await waitFor(() => pids.every((pid) => !isAlive(pid)), "budget descendant cleanup", 2000);
  assert(!existsSync(lockFile), "lock remained after budget process-group cleanup");
});

await test("serial lock cancellation kills signal-ignoring descendants before releasing the lock", async () => {
  const resource = uniqueName("cancel-process-group");
  const lockFile = join(testRoot, `${resource}.lock`);
  const pidFile = join(testRoot, `${resource}.pids`);
  const holder = spawnLock(resource, lockFile, 1, [
    process.execPath,
    "-e",
    SIGNAL_IGNORING_TREE_CODE,
    pidFile,
  ], {
    SERIAL_LOCK_KILL_GRACE_MS: "50",
    SERIAL_LOCK_GROUP_POLL_MS: "10",
  });
  try {
    await waitFor(() => existsSync(pidFile), "cancellation descendant fixture");
    holder.child.kill("SIGTERM");
    const result = await holder.result;
    assert(result.code === 1, `cancelled wrapper must fail nonzero: ${result.code}: ${result.output}`);
    const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    assert(pids.length === 2, `cancellation fixture recorded ${pids.length} processes instead of two`);
    await waitFor(() => pids.every((pid) => !isAlive(pid)), "cancellation descendant cleanup", 2000);
    assert(!existsSync(lockFile), "lock remained after cancellation process-group cleanup");
  } finally {
    if (holder.child.exitCode === null) holder.child.kill("SIGKILL");
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
  const serverClosed = new Promise((resolveServer) => server.once("close", resolveServer));
  try {
    await waitFor(() => /PORT:\d+/.test(serverOutput), "descendant TCP listener");
    const port = Number(serverOutput.match(/PORT:(\d+)/)[1]);
    const result = await runProcess(process.execPath, [FREE_PORTS, String(port)]);
    assert(result.code === 1, `protected cleanup exited ${result.code}: ${result.output}`);
    assert(result.output.includes("refusing to claim port"), `missing protected refusal: ${result.output}`);
    assert(server.exitCode === null, "protected listener was terminated");

    const takeover = await runProcess(
      process.execPath,
      [FREE_PORTS, "--include-own-tree", String(port)],
    );
    assert(takeover.code === 0, `takeover cleanup exited ${takeover.code}: ${takeover.output}`);
    await waitFor(
      () => server.exitCode !== null || server.signalCode !== null,
      "same-supervisor stale listener termination",
    );
    await serverClosed;
    assert(isAlive(process.pid), "takeover cleanup terminated its invoking process");

    const replacement = createServer();
    await new Promise((resolveListen, rejectListen) => {
      replacement.once("error", rejectListen);
      replacement.listen(port, "127.0.0.1", resolveListen);
    });
    await new Promise((resolveClose, rejectClose) =>
      replacement.close((error) => error ? rejectClose(error) : resolveClose()),
    );
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await serverClosed;
    }
  }
});

await test("fast port check rejects development startup without safe takeover", async () => {
  const fixtureRoot = join(testRoot, "startup-drift-fixture");
  for (const artifact of ["parts-id", "api-server", "mockup-sandbox"]) {
    for (const relative of [
      join(".replit-artifact", "artifact.toml"),
      "package.json",
    ]) {
      const source = join(ROOT, "artifacts", artifact, relative);
      const target = join(fixtureRoot, artifact, relative);
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(source, target);
    }
  }

  const apiPackagePath = join(fixtureRoot, "api-server", "package.json");
  const apiPackage = JSON.parse(readFileSync(apiPackagePath, "utf8"));
  apiPackage.scripts.dev = apiPackage.scripts.dev.replace(" --include-own-tree", "");
  writeFileSync(apiPackagePath, `${JSON.stringify(apiPackage, null, 2)}\n`);

  const result = await runProcess(
    "bash",
    [PORT_CHECK],
    { ...process.env, PORT_CONTRACT_ARTIFACT_ROOT: fixtureRoot },
  );
  assert(result.code === 1, `startup drift fixture exited ${result.code}: ${result.output}`);
  assert(
    result.output.includes(
      "API Server development startup must begin with the canonical port cleaner and --include-own-tree before launching the replacement service",
    ),
    `missing actionable startup drift diagnostic: ${result.output}`,
  );
});

await test("fast port check rejects artifact manifest drift", async () => {
  const fixtureRoot = join(testRoot, "manifest-drift-fixture");
  for (const artifact of ["parts-id", "api-server", "mockup-sandbox"]) {
    for (const relative of [
      join(".replit-artifact", "artifact.toml"),
      "package.json",
    ]) {
      const source = join(ROOT, "artifacts", artifact, relative);
      const target = join(fixtureRoot, artifact, relative);
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(source, target);
    }
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