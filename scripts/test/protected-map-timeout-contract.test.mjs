#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProtectedMapSmoke, runSuite } from "../run-protected-map-smoke.mjs";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "protected-map-timeout-contract-"));
const descendantPidPath = join(fixtureDirectory, "descendant.pid");
const fixtureCode = `
  import { spawn } from "node:child_process";
  import { writeFileSync } from "node:fs";

  const mode = process.argv[1];
  if (mode === "normal") {
    process.exit(0);
  }

  const descendant = spawn(
    process.execPath,
    ["--input-type=module", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  writeFileSync(process.argv[2], String(descendant.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
`;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}

const logs = [];
const errors = [];
try {
  const normal = await runSuite("normal-suite", {
    command: process.execPath,
      args: ["--input-type=module", "-e", fixtureCode, "normal"],
    timeoutMs: 250,
    terminationGraceMs: 75,
  });
  assert.equal(normal.code, 0, "a normally completing suite must pass");
  assert.equal(normal.timedOut, false, "a normally completing suite must not time out");

  const outcome = await runProtectedMapSmoke({
    suiteFiles: ["term-resistant-suite"],
    runSuiteImpl: runSuite,
    getRunSuiteOptions: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", fixtureCode, "hang", descendantPidPath],
      timeoutMs: 150,
      terminationGraceMs: 75,
    }),
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  });

  assert.equal(outcome.failed, true, "a timed-out suite must fail the smoke result");
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].file, "term-resistant-suite");
  assert.equal(outcome.results[0].code, 124);
  assert.equal(outcome.results[0].timedOut, true);
  assert.match(
    errors.join("\n"),
    /FAILED owner=term-resistant-suite reason=timeout timeout=150ms exit=124/,
    "timeout output must identify the suite that owns the timeout",
  );

  const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
  assert(Number.isInteger(descendantPid) && descendantPid > 0, "fixture must record its descendant PID");
  assert.equal(
    await waitForExit(descendantPid),
    true,
    "hard-kill escalation must leave no owned descendant running",
  );
  assert.deepEqual(logs, [], "a failed smoke must not report an all-passed message");
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("Protected-map timeout contract: normal completion, timeout ownership, and descendant cleanup passed");