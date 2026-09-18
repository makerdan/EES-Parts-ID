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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export function runSuite(
  file,
  {
    command = "pnpm",
    args = ["--filter", "@workspace/mockup-sandbox", "exec", "vitest", "run", file],
    timeoutMs = SUITE_TIMEOUT_MS,
    terminationGraceMs = TERMINATION_GRACE_MS,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let escalationTimer;
    let forceFinishTimer;
    let terminationComplete = false;
    let pendingResult;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      output += `[protected-map-smoke] timed out after ${timeoutMs} ms; terminating process group\n`;
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
            terminationGraceMs,
          );
        }
      }, terminationGraceMs);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      clearTimeout(forceFinishTimer);
      resolve({ ...result, timedOut, timeoutMs });
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

export async function runProtectedMapSmoke({
  suiteFiles = suites,
  runSuiteImpl = runSuite,
  getRunSuiteOptions = () => undefined,
  log = console.log,
  error = console.error,
} = {}) {
  const results = await Promise.all(
    suiteFiles.map((file) => runSuiteImpl(file, getRunSuiteOptions(file))),
  );
  let failed = false;

  for (const result of results) {
    if (result.code === 0) {
      log(`[protected-map-smoke] PASSED owner=${result.file}`);
      continue;
    }

    failed = true;
    error(
      `[protected-map-smoke] FAILED owner=${result.file} ${
        result.timedOut ? `reason=timeout timeout=${result.timeoutMs ?? SUITE_TIMEOUT_MS}ms ` : ""
      }exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""}`,
    );
    if (result.output?.trim()) {
      error(result.output.trimEnd());
    }
  }

  if (failed) {
    error(
      "[protected-map-smoke] one or more protected map suites failed; ownership is reported above",
    );
  } else {
    log(
      `[protected-map-smoke] all ${results.length} protected map suites passed concurrently`,
    );
  }

  return { failed, results };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const { failed } = await runProtectedMapSmoke();
  if (failed) process.exitCode = 1;
}