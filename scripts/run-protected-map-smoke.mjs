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

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/mockup-sandbox", "exec", "vitest", "run", file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      resolve({ file, code: 1, output: `${output}${error.stack ?? error}\n` });
    });
    child.on("close", (code, signal) => {
      resolve({
        file,
        code: code ?? 1,
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
    `[protected-map-smoke] FAILED owner=${result.file} exit=${result.code}${
      result.signal ? ` signal=${result.signal}` : ""
    }`,
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