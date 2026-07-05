/**
 * Standalone integration runner for the Clerk proxy mid-stream reset test.
 *
 * Run via:  tsx __tests__/clerkProxyReset.integration.runner.ts
 *
 * This script intentionally lives OUTSIDE Jest's CJS module sandbox so it can
 * load the real `http-proxy-middleware` (ESM-only package) and therefore
 * exercise the real `clerkProxyMiddleware` end-to-end.  The Jest wrapper
 * (clerkProxyReset.integration.test.ts) spawns it as a child process and
 * asserts exit code 0.
 *
 * Architecture
 * ─────────────
 *   [test client]  ──GET──▶  [Express app  (:proxyPort)]  ──GET──▶  [fake upstream  (:upstreamPort)]
 *                             (real clerkProxyMiddleware               (raw TCP; path-based dispatch)
 *                              + real http-proxy-middleware)
 *
 * The fake upstream uses path-based dispatch so each probe is independent of
 * TCP connection reuse / ordering:
 *   /reset-content-length  → send Content-Length:1000 header + 7 bytes, then ECONNRESET
 *   /reset-chunked         → send Transfer-Encoding: chunked + one chunk, then ECONNRESET
 *   /ok                    → send full body, close cleanly
 *
 * Scenarios verified (one probe per path):
 *   1. Content-Length response, upstream resets before body is complete
 *      → streaming branch: headers sent, res.destroy() called
 *      → client receives error or hard close within 2 s (not hung)
 *   2. Chunked / no Content-Length, upstream resets before body ends
 *      → buffering branch: headers NOT sent, proxy sends 502 to client
 *      → client receives a 502 response (not hung)
 *   3. Happy path: full body delivered cleanly
 *      → client receives 200 + correct body
 *
 * No unhandled rejection is emitted by the proxy process in any scenario.
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — at least one assertion failed (details on stderr)
 */

import * as http from "node:http";
import * as net from "node:net";

// ── Assertion helpers ──────────────────────────────────────────────────────────

const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (!condition) {
    failures.push(message);
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

// ── Fake upstream (raw TCP, path-based dispatch) ───────────────────────────────

const HAPPY_BODY = "Hello from real clerkProxyMiddleware!";

/**
 * Parses the request-target (first line of an HTTP/1.x request) from the raw
 * bytes received on a TCP socket.  Returns the path portion or "/" if it
 * cannot be parsed.  The `data` event on a net.Socket can deliver either a
 * Buffer or a string depending on the encoding set on the socket.
 */
function parseRequestPath(data: Buffer | string): string {
  const raw = typeof data === "string" ? data : data.toString("utf8");
  const line = raw.split("\r\n")[0] ?? "";
  // "GET /some/path HTTP/1.1"
  const parts = line.split(" ");
  return parts[1] ?? "/";
}

/**
 * Starts a raw TCP server that speaks just enough HTTP to satisfy
 * `http-proxy-middleware`.  Path-based dispatch decides the response behaviour
 * so tests are independent of TCP connection reuse order.
 */
function startFakeUpstream(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once("data", (data) => {
        const path = parseRequestPath(data);

        if (path.includes("reset-content-length")) {
          // ── Streaming branch: send Content-Length, partial body, then reset ──
          // clerkProxyMiddleware sees Content-Length → takes streaming path →
          // calls writeHead + pipe on the client res.  When the upstream resets,
          // proxyRes "error" fires → res.destroy() is called.
          socket.write(
            "HTTP/1.1 200 OK\r\n" +
              "Content-Type: text/plain\r\n" +
              "Connection: close\r\n" +
              "Content-Length: 1000\r\n" + // promises 1 000 bytes …
              "\r\n" +
              "partial", // … but delivers only 7
          );
          setImmediate(() => socket.destroy());
        } else if (path.includes("reset-chunked")) {
          // ── Buffering branch: no Content-Length, upstream resets before end ──
          // clerkProxyMiddleware sees no Content-Length → takes buffering path →
          // accumulates chunks.  When the upstream resets, the buffering error
          // handler fires: since headers are NOT yet sent (still buffering) it
          // sends res.writeHead(502) + res.end() to the client.
          socket.write(
            "HTTP/1.1 200 OK\r\n" +
              "Content-Type: text/plain\r\n" +
              "Connection: close\r\n" +
              "Transfer-Encoding: chunked\r\n" +
              "\r\n" +
              "7\r\npartial\r\n", // one valid chunk, then abrupt close
          );
          setImmediate(() => socket.destroy());
        } else {
          // ── Happy path: full body, clean close ────────────────────────────────
          // Connection: close prevents the proxy's HTTP agent from trying to
          // reuse this TCP socket for a subsequent request, which could cause a
          // stale-socket error after an earlier scenario destroyed its socket.
          socket.write(
            "HTTP/1.1 200 OK\r\n" +
              "Content-Type: text/plain\r\n" +
              "Connection: close\r\n" +
              `Content-Length: ${HAPPY_BODY.length}\r\n` +
              "\r\n" +
              HAPPY_BODY,
          );
          socket.end();
        }
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ── Express app with real clerkProxyMiddleware ─────────────────────────────────

interface ProxyApp {
  port: number;
  close: () => Promise<void>;
}

/**
 * Creates a minimal Express app mounting the REAL `clerkProxyMiddleware` (which
 * pulls in the real `http-proxy-middleware`).
 *
 * Must be called AFTER `process.env.CLERK_FAPI_URL`, `NODE_ENV`, and
 * `CLERK_SECRET_KEY` are set, because `clerkProxyMiddleware.ts` reads those
 * values at module-load time (module-level constants).
 */
async function startProxyApp(): Promise<ProxyApp> {
  // tsx on Node v24 requires explicit .ts extensions in ESM packages.
  const { clerkProxyMiddleware, CLERK_PROXY_PATH } = await import(
    "../src/middlewares/clerkProxyMiddleware.ts"
  );
  const { default: express } = await import("express");

  const app = express();
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
    server.on("error", reject);
  });
}

// ── Client probe ───────────────────────────────────────────────────────────────

type RequestOutcome =
  | { kind: "response"; statusCode: number; body: string }
  | { kind: "error"; code: string }
  | { kind: "close" };

/**
 * Sends a GET to `http://127.0.0.1:<port>/api/__clerk/<subPath>` and returns a
 * Promise that settles as soon as the connection resolves or `timeoutMs`
 * elapses.  A hung connection causes the Promise to reject.
 */
function probe(
  port: number,
  subPath: string,
  timeoutMs = 2_000,
): Promise<RequestOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: RequestOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(
          new Error(
            `probe: timed out after ${timeoutMs} ms — connection appears hung`,
          ),
        );
      }
    }, timeoutMs);

    const req = http.get(
      { host: "127.0.0.1", port, path: `/api/__clerk/${subPath}` },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          settle({
            kind: "response",
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", (err: NodeJS.ErrnoException) =>
          settle({ kind: "error", code: err.code ?? err.message }),
        );
        // "close" fires on abnormal socket close even when "end" does not.
        res.on("close", () => settle({ kind: "close" }));
      },
    );

    req.on("error", (err: NodeJS.ErrnoException) =>
      settle({ kind: "error", code: err.code ?? err.message }),
    );
  });
}

// ── Unhandled rejection tracking ──────────────────────────────────────────────

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandledRejections.push(reason));

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const upstream = await startFakeUpstream();

  // Set env vars BEFORE the dynamic import so module-level constants in
  // clerkProxyMiddleware.ts pick them up on first load.
  process.env.CLERK_FAPI_URL = `http://127.0.0.1:${upstream.port}`;
  process.env.NODE_ENV = "production";
  process.env.CLERK_SECRET_KEY = "sk_test_fake_integration";

  let proxy: ProxyApp | null = null;

  try {
    proxy = await startProxyApp();

    // ── Scenario 1: Content-Length response, upstream resets before body ends ───
    //
    // clerkProxyMiddleware streaming branch: has Content-Length →
    //   res.writeHead(200, {...}) + proxyRes.pipe(res)
    //   proxyRes "error" → res.destroy()
    // Expected client outcome: error or hard close (NOT a hung promise).
    {
      console.log(
        "\n─── Scenario 1: Content-Length response — upstream resets mid-body ───",
      );
      const beforeCount = unhandledRejections.length;
      const outcome = await probe(proxy.port, "reset-content-length");
      // Allow the ECONNRESET to fully propagate through Node.js's networking
      // layer before the next scenario opens a new upstream connection.
      // A single setImmediate is not sufficient; 100 ms is reliably enough.
      await new Promise((r) => setTimeout(r, 100));
      const newRejections = unhandledRejections.length - beforeCount;

      assert(
        outcome.kind === "error" || outcome.kind === "close",
        `Scenario 1: client receives error or hard close — not a hung promise (got kind="${outcome.kind}")`,
      );
      assert(
        newRejections === 0,
        `Scenario 1: no unhandled rejection in the proxy process (got ${newRejections})`,
      );
    }

    // ── Scenario 2: Chunked / no Content-Length, upstream resets mid-body ───────
    //
    // clerkProxyMiddleware buffering branch: no Content-Length →
    //   accumulates chunks; when upstream resets before all data arrives,
    //   error handler fires with res.headersSent === false →
    //   res.writeHead(502) + res.end()
    // Expected client outcome: 502 response (NOT a hung promise).
    {
      console.log(
        "\n─── Scenario 2: Chunked response — upstream resets mid-body ───",
      );
      const beforeCount = unhandledRejections.length;
      const outcome = await probe(proxy.port, "reset-chunked");
      await new Promise((r) => setTimeout(r, 100));
      const newRejections = unhandledRejections.length - beforeCount;

      assert(
        outcome.kind === "response",
        `Scenario 2: client receives a response (got kind="${outcome.kind}")`,
      );
      if (outcome.kind === "response") {
        assert(
          outcome.statusCode === 502,
          `Scenario 2: buffering-branch upstream reset returns 502 to client (got ${outcome.statusCode})`,
        );
      }
      assert(
        newRejections === 0,
        `Scenario 2: no unhandled rejection in the proxy process (got ${newRejections})`,
      );
    }

    // ── Scenario 3: Happy path — full body delivered cleanly ─────────────────────
    //
    // Expected client outcome: 200 with the full body.
    {
      console.log(
        "\n─── Scenario 3: Happy path — upstream delivers the full body cleanly ───",
      );
      const beforeCount = unhandledRejections.length;
      const outcome = await probe(proxy.port, "ok");
      await new Promise((r) => setTimeout(r, 100));
      const newRejections = unhandledRejections.length - beforeCount;

      assert(
        outcome.kind === "response",
        `Scenario 3: client receives a complete response (got kind="${outcome.kind}")`,
      );
      if (outcome.kind === "response") {
        assert(
          outcome.statusCode === 200,
          `Scenario 3: status 200 (got ${outcome.statusCode})`,
        );
        assert(
          outcome.body === HAPPY_BODY,
          `Scenario 3: body matches expected (got ${JSON.stringify(outcome.body)})`,
        );
      }
      assert(
        newRejections === 0,
        `Scenario 3: no unhandled rejection in the proxy process (got ${newRejections})`,
      );
    }
  } finally {
    await proxy?.close();
    await upstream.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll assertions passed.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Runner crashed:", err);
  process.exit(1);
});
