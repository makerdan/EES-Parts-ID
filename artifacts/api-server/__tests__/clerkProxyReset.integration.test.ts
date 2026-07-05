/**
 * Integration test: mid-stream upstream reset propagates as a hard close to the
 * client — no hung promise.
 *
 * This test wraps a standalone integration runner
 * (`clerkProxyReset.integration.runner.ts`) that exercises the REAL
 * `clerkProxyMiddleware` together with the REAL `http-proxy-middleware` package
 * end-to-end.  The runner lives outside Jest's CJS module sandbox specifically
 * because `http-proxy-middleware` ships ESM-only and cannot be `require()`d in
 * the Jest CJS environment (which is why `jest.config.cjs` stubs it globally).
 *
 * The Jest test:
 *   1. Spawns `tsx` with the runner script as a child process.
 *   2. Captures stdout/stderr for diagnostic output on failure.
 *   3. Asserts the runner exits with code 0 within the test timeout.
 *
 * Scenarios exercised by the runner (see its file header for details):
 *   1. Content-Length response — upstream resets before body is complete
 *      → streaming branch: res.destroy() called → client gets error/hard close
 *   2. Chunked / no Content-Length — upstream resets before body ends
 *      → buffering branch: proxy sends 502 → client gets response (not hung)
 *   3. Happy path — upstream delivers full body cleanly
 *      → client gets 200 + full body
 *   All scenarios: no unhandled rejection emitted by the proxy process.
 *
 * Relevant files:
 *   - `artifacts/api-server/__tests__/clerkProxyReset.integration.runner.ts`
 *   - `artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts`
 */

import { spawn } from "child_process";
import * as path from "path";

// ts-jest compiles this file to CommonJS, so __dirname is available as a
// built-in global — no import.meta.url needed.
/** Resolves a path relative to this test file's directory. */
const resolve = (...parts: string[]) => path.resolve(__dirname, ...parts);

describe("clerkProxyMiddleware — mid-stream reset integration (subprocess runner)", () => {
  it(
    "passes all runner assertions: resets close the client promptly, happy path returns 200, no unhandled rejections",
    (done) => {
      const tsxBin = resolve("..", "node_modules", ".bin", "tsx");
      const runnerScript = resolve("clerkProxyReset.integration.runner.ts");

      const child = spawn(tsxBin, [runnerScript], {
        cwd: resolve(".."),
        stdio: "pipe",
        env: {
          ...process.env,
          // Ensure the subprocess does not inherit a mocked environment from Jest.
          // Clear any Jest-specific env that might confuse the real middleware.
          JEST_WORKER_ID: undefined,
        },
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("close", (code) => {
        const out = Buffer.concat(stdout).toString();
        const err = Buffer.concat(stderr).toString();

        if (code !== 0) {
          // Print runner output so the test failure is self-explanatory.
          console.error("=== runner stdout ===\n" + out);
          console.error("=== runner stderr ===\n" + err);
          done(
            new Error(
              `Integration runner exited with code ${code}.\n` +
                `See console output above for failed assertions.`,
            ),
          );
        } else {
          done();
        }
      });

      child.on("error", (spawnErr) => {
        done(new Error(`Failed to spawn runner: ${spawnErr.message}`));
      });
    },
    // Override the default 10 s timeout: the runner starts two TCP servers and
    // an Express app, so allow 15 s for cold-start and network setup.
    15_000,
  );
});
