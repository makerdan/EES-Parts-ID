#!/usr/bin/env node
/**
 * Run the protected map route workflows concurrently.
 *
 * This is intentionally separate from scripts/test-all.sh: the canonical
 * artifact suites keep their serialized result ownership, while this focused
 * smoke run exercises the three route workflows under the CPU/load pressure
 * that previously exposed false-ready scenes.
 */
import { spawn } from "node:child_process";

const suites = [
  "src/__tests__/WarehouseMapRoute.test.tsx",
  "src/__tests__/ZoneEditorRouteWorkflow.test.tsx",
  "src/__tests__/AnchorCalibrationRoute.test.tsx",
];

const configuredSuiteTimeoutMs = Number(process.env.PROTECTED_MAP_SUITE_TIMEOUT_MS ?? 120_000);
const SUITE_TIMEOUT_MS =
  Number.isFinite(configuredSuiteTimeoutMs) && configuredSuiteTimeoutMs > 0
    ? configuredSuiteTimeoutMs
    : 120_000;
const TERMINATION_GRACE_MS = 1_000;

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch (fallbackError) {
        if (fallbackError.code !== "ESRCH") throw fallbackError;
      }
    }
  }
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/mockup-sandbox", "exec", "vitest", "run", file],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let timedOut = false;
    let settled = false;
    let escalationTimer;
    let forceFinishTimer;
    let terminationComplete = false;
    let pendingResult;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      output += `[protected-map-smoke] timed out after ${SUITE_TIMEOUT_MS} ms; terminating process group\n`;
      killProcessGroup(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        terminationComplete = true;
        if (pendingResult) {
          finish(pendingResult);
        } else {
          forceFinishTimer = setTimeout(
            () =>
              finish({
                file,
                code: 124,
                signal: "SIGKILL",
                output,
              }),
            TERMINATION_GRACE_MS,
          );
        }
      }, TERMINATION_GRACE_MS);
    }, SUITE_TIMEOUT_MS);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      clearTimeout(forceFinishTimer);
      resolve({ ...result, timedOut });
    };

    const reportResult = (result) => {
      if (timedOut && !terminationComplete) {
        pendingResult = result;
        return;
      }
      finish(result);
    };

    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      reportResult({ file, code: 1, output: `${output}${error.stack ?? error}\n` });
    });
    child.on("close", (code, signal) => {
      reportResult({
        file,
        code: timedOut ? 124 : code ?? 1,
        signal,
        output,
      });
    });
  });
}

const results = await Promise.all(suites.map(runSuite));
let failed = false;

for (const result of results) {
  if (result.code === 0) {
    console.log(`[protected-map-smoke] PASSED owner=${result.file}`);
    continue;
  }

  failed = true;
  console.error(
    `[protected-map-smoke] FAILED owner=${result.file} ${
      result.timedOut ? `reason=timeout timeout=${SUITE_TIMEOUT_MS}ms ` : ""
    }exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""}`,
  );
  if (result.output.trim()) {
    process.stderr.write(`${result.output.trimEnd()}\n`);
  }
}

if (failed) {
  console.error(
    "[protected-map-smoke] one or more protected map suites failed; ownership is reported above",
  );
  process.exit(1);
}

console.log(
  `[protected-map-smoke] all ${results.length} protected map suites passed concurrently`,
);