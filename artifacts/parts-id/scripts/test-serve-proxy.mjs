#!/usr/bin/env node
/**
 * Integration smoke-test for the /api/* reverse-proxy in server/serve.js.
 *
 * Starts:
 *   1. A stub API server on a random free port.
 *   2. serve.js (the production static + proxy server) with API_SERVER_PORT
 *      pointing at the stub.
 *
 * Asserts:
 *   ✓ GET /api/health → proxied status + body arrive unchanged.
 *   ✓ POST /api/data with JSON body → stub receives the full body unchanged.
 *   ✓ Authorization header is forwarded to the stub unchanged.
 *   ✓ Response headers from the stub reach the client.
 *   ✓ Downstream disconnect before upstream acceptance → the upstream request/socket closes.
 *   ✓ Downstream disconnect after response chunks begin → the upstream response/socket closes.
 *   ✓ Active response chunks keep streaming beyond the initial timeout.
 *   ✓ Slow downstream consumption preserves ordered multi-chunk responses and cleanup.
 *   ✓ Stalled upstream → bounded 504 JSON response and upstream cleanup.
 *   ✓ Upstream closes before response completion → bounded downstream close and cleanup.
 *   ✓ API server down → 502 JSON response, serve.js does not crash.
 *
 * Exit: 0 on all-pass, 1 on any failure.
 */

import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_JS = resolve(__dirname, "..", "server", "serve.js");
const REQUEST_TIMEOUT_MS = 5_000;
const SERVER_CLOSE_TIMEOUT_MS = 2_000;
const CHILD_CLOSE_TIMEOUT_MS = 2_000;
const SOCKETS = Symbol("owned sockets");
const CLOSE_PROMISE = Symbol("close promise");
const BACKPRESSURE_CHUNKS = Array.from({ length: 8 }, (_, index) => {
  const prefix = `backpressure chunk ${index}\n`;
  return prefix + "x".repeat(64 * 1024 - Buffer.byteLength(prefix));
});

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Start an HTTP server on a random OS-assigned port. Returns { server, port }. */
function listenRandom(handler) {
  return new Promise((ok, fail) => {
    const srv = http.createServer(handler);
    srv[SOCKETS] = new Set();
    srv.on("connection", (socket) => {
      srv[SOCKETS].add(socket);
      socket.on("close", () => srv[SOCKETS].delete(socket));
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (srv.address());
      ok({ server: srv, port });
    });
    srv.on("error", fail);
  });
}

/** Gracefully close an HTTP server. */
function closeServer(srv, timeoutMs = SERVER_CLOSE_TIMEOUT_MS) {
  if (!srv) return Promise.resolve();
  if (srv[CLOSE_PROMISE]) return srv[CLOSE_PROMISE];
  srv[CLOSE_PROMISE] = new Promise((ok) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ok();
    };
    if (!srv.listening) {
      finish();
      return;
    }
    timer = setTimeout(() => {
      for (const socket of srv[SOCKETS] ?? []) socket.destroy();
      srv.closeAllConnections?.();
      srv.closeIdleConnections?.();
      finish();
    }, timeoutMs);
    try {
      srv.close(finish);
    } catch (error) {
      finish();
    }
  });
  return srv[CLOSE_PROMISE];
}

/** Claim a random free port then release it (a best-effort port picker). */
async function pickFreePort() {
  const { server, port } = await listenRandom(() => {});
  await closeServer(server);
  return port;
}

/** Poll until TCP port accepts a connection, or reject after timeoutMs. */
function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((ok, fail) => {
    let settled = false;
    let retryTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      callback(value);
    };
    const attempt = () => {
      if (Date.now() > deadline) {
        return finish(fail, new Error(`Port ${port} never opened within ${timeoutMs} ms`));
      }
      const sock = net.createConnection(port, "127.0.0.1");
      const remainingMs = Math.max(1, deadline - Date.now());
      sock.setTimeout(remainingMs, () => {
        sock.destroy();
        finish(fail, new Error(`Port ${port} never opened within ${timeoutMs} ms`));
      });
      sock.on("connect", () => {
        sock.destroy();
        finish(ok);
      });
      sock.on("error", () => {
        sock.destroy();
        if (!settled) retryTimer = setTimeout(attempt, 80);
      });
    };
    attempt();
  });
}

/**
 * Send an HTTP request and resolve with { status, headers, body }.
 * @param {{ port: number; path: string; method?: string; headers?: Record<string,string>; body?: string; timeoutMs?: number }} opts
 */
function sendRequest(opts) {
  return new Promise((ok, fail) => {
    const payload = opts.body != null ? Buffer.from(opts.body) : undefined;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let response;
    let settled = false;
    const timeoutId = setTimeout(() => {
      const error = new Error(`HTTP request ${opts.method ?? "GET"} ${opts.path} timed out after ${timeoutMs} ms`);
      error.code = "ETIMEDOUT";
      response?.destroy(error);
      req.destroy(error);
      finish(fail, error);
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };
    const reqOpts = {
      hostname: "127.0.0.1",
      port: opts.port,
      path: opts.path,
      method: opts.method ?? "GET",
      headers: {
        ...opts.headers,
        ...(payload ? { "content-length": String(payload.byteLength) } : {}),
      },
    };
    const req = http.request(reqOpts, (res) => {
      response = res;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        finish(ok, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", (error) => finish(fail, error));
    });
    req.on("close", () => opts.onRequestClose?.());
    req.on("error", (error) => finish(fail, error));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Consume a response one pause-delimited read at a time. */
function sendSlowRequest(opts) {
  return new Promise((ok, fail) => {
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const delayMs = opts.delayMs;
    let response;
    let settled = false;
    let pauseTimer;
    const timeoutId = setTimeout(() => {
      const error = new Error(
        `slow HTTP request ${opts.method ?? "GET"} ${opts.path} timed out after ${timeoutMs} ms`,
      );
      response?.destroy(error);
      req.destroy(error);
      finish(fail, error);
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(pauseTimer);
      callback(value);
    };
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: { connection: "close" },
        agent: false,
      },
      (res) => {
        response = res;
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          res.pause();
          clearTimeout(pauseTimer);
          pauseTimer = setTimeout(() => {
            pauseTimer = undefined;
            res.resume();
          }, delayMs);
        });
        res.on("end", () =>
          finish(ok, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (error) => finish(fail, error));
      },
    );
    req.on("error", (error) => finish(fail, error));
  });
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
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

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, timeoutMs = CHILD_CLOSE_TIMEOUT_MS) {
  if (!child) return;
  killProcessGroup(child, "SIGTERM");
  await waitForChildExit(child, timeoutMs);
  killProcessGroup(child, "SIGKILL");
  await waitForChildExit(child, 500);
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs} ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function makeStaticArtifactFixture() {
  const staticRoot = fs.mkdtempSync(join(os.tmpdir(), "parts-id-serve-artifact-"));
  const webJsRoot = join(staticRoot, "web", "_expo", "static", "js", "web");
  fs.mkdirSync(webJsRoot, { recursive: true });
  fs.mkdirSync(join(staticRoot, "ios"), { recursive: true });
  fs.mkdirSync(join(staticRoot, "android"), { recursive: true });
  fs.writeFileSync(join(staticRoot, "web", "index.html"), "<script src=\"bundle.js\"></script>\n");
  fs.writeFileSync(join(staticRoot, "web", "metadata.json"), "{}\n");
  fs.writeFileSync(join(staticRoot, "ios", "manifest.json"), "{}\n");
  fs.writeFileSync(join(staticRoot, "android", "manifest.json"), "{}\n");
  fs.writeFileSync(
    join(webJsRoot, "entry.js"),
    'const API = "https://parts-id.replit.app";\n',
  );
  fs.writeFileSync(
    join(staticRoot, "build-metadata.json"),
    JSON.stringify({
      version: 1,
      buildId: "proxy-test-build",
      builtAt: new Date().toISOString(),
      webEntry: "web/index.html",
      manifests: ["ios/manifest.json", "android/manifest.json"],
    }) + "\n",
  );
  return staticRoot;
}

// ─── tiny test runner ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("serve.js proxy integration tests\n");

  // ── 1. Stub API server ───────────────────────────────────────────────────
  /** Captured requests from the stub (for assertion in tests). */
  const captured = [];
  let uploadRequestAccepted = false;
  let uploadRequestCompleted = false;
  let uploadRequestClosed = false;
  let uploadRequestSocketClosed = false;
  let streamChunkSent = false;
  let streamResponseClosed = false;
  let streamRequestSocketClosed = false;
  let activeStreamChunkSent = false;
  let activeStreamResponseClosed = false;
  let backpressureResponseClosed = false;
  let backpressureRequestSocketClosed = false;
  let incompleteResponseClosed = false;
  let incompleteRequestSocketClosed = false;
  let stalledRequestReceived = false;
  let stalledResponseClosed = false;
  let stubServer;
  let child;
  let exitCode = 0;
  const staticRoot = makeStaticArtifactFixture();

  try {
    const stub = await listenRandom((req, res) => {
      const chunks = [];
      req.on("data", (c) => {
        chunks.push(c);
      });
      if (req.url === "/api/upload") {
        uploadRequestAccepted = true;
        req.on("close", () => {
          uploadRequestClosed = true;
        });
        req.socket.on("close", () => {
          uploadRequestSocketClosed = true;
        });
        req.pause();
        const resumeTimer = setTimeout(() => req.resume(), 500);
        req.once("close", () => clearTimeout(resumeTimer));
      }
      if (req.url === "/api/stream") {
        res.on("close", () => {
          streamResponseClosed = true;
        });
        req.socket.on("close", () => {
          streamRequestSocketClosed = true;
        });
      }
      req.on("end", () => {
        if (req.url === "/api/upload") uploadRequestCompleted = true;
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        captured.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: bodyStr,
        });

        if (req.url === "/api/stall") {
          stalledRequestReceived = true;
          res.on("close", () => {
            stalledResponseClosed = true;
          });
          return;
        }

        if (req.url === "/api/stream") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          });
          res.write("first response chunk");
          streamChunkSent = true;
          return;
        }

        if (req.url === "/api/active-stream") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          });
          let chunkNumber = 0;
          const interval = setInterval(() => {
            chunkNumber++;
            activeStreamChunkSent = true;
            res.write(`active response chunk ${chunkNumber}\n`);
            if (chunkNumber === 5) {
              clearInterval(interval);
              res.end("active response complete\n");
            }
          }, 60);
          res.on("close", () => {
            activeStreamResponseClosed = true;
            clearInterval(interval);
          });
          return;
        }

        if (req.url === "/api/backpressure-stream") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          });
          res.on("close", () => {
            backpressureResponseClosed = true;
          });
          req.socket.on("close", () => {
            backpressureRequestSocketClosed = true;
          });
          let chunkNumber = 0;
          const interval = setInterval(() => {
            res.write(BACKPRESSURE_CHUNKS[chunkNumber]);
            chunkNumber++;
            if (chunkNumber === BACKPRESSURE_CHUNKS.length) {
              clearInterval(interval);
              res.end();
            }
          }, 25);
          res.on("close", () => clearInterval(interval));
          return;
        }

        if (req.url === "/api/incomplete") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "transfer-encoding": "chunked",
          });
          res.write("partial response");
          setTimeout(() => res.destroy(), 20);
          res.on("close", () => {
            incompleteResponseClosed = true;
          });
          req.socket.on("close", () => {
            incompleteRequestSocketClosed = true;
          });
          return;
        }

        if (req.url === "/api/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else if (req.url === "/api/data") {
          res.writeHead(201, {
            "content-type": "application/json",
            "x-custom-resp": "yes",
          });
          res.end(JSON.stringify({ received: bodyStr }));
        } else {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });
    stubServer = stub.server;

    // ── 2. Pick a port for the static server, then spawn serve.js ───────────
    const staticPort = await pickFreePort();

    child = spawn("node", [SERVE_JS], {
      detached: true,
      env: {
        ...process.env,
        PORT: String(staticPort),
        API_SERVER_PORT: String(stub.port),
        PARTS_ID_STATIC_ROOT: staticRoot,
        PARTS_ID_SERVER_MODE: "production",
        API_PROXY_TIMEOUT_MS: "150",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.resume();
    child.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) process.stderr.write(`  [serve.js] ${msg}\n`);
    });

    await waitForPort(staticPort, 5000);
    // Convenience wrapper: send a request through the proxy server.
    const via = (opts) => sendRequest({ ...opts, port: staticPort });

    // ── 3. Tests ─────────────────────────────────────────────────────────────

    // 3a. GET /api/health → proxied status + body
    await test("GET /api/health is proxied with correct status and body", async () => {
      captured.length = 0;
      const res = await via({ path: "/api/health" });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const parsed = JSON.parse(res.body);
      assert.deepEqual(parsed, { status: "ok" });
      assert.equal(captured.length, 1, "stub should receive exactly one request");
      assert.equal(captured[0].url, "/api/health");
      assert.equal(captured[0].method, "GET");
    });

    // 3b. POST /api/data with JSON body → body arrives at stub unchanged
    await test("POST /api/data — JSON body forwarded to stub unchanged", async () => {
      captured.length = 0;
      const payload = JSON.stringify({ foo: "bar", n: 42 });
      const res = await via({
        path: "/api/data",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      assert.equal(res.status, 201, `expected 201, got ${res.status}`);
      assert.equal(captured.length, 1, "stub should receive exactly one request");
      assert.equal(captured[0].body, payload, "body mismatch at stub");
      assert.equal(captured[0].method, "POST");
    });

    // 3c. Authorization header forwarded unchanged
    await test("Authorization header is forwarded to the stub unchanged", async () => {
      captured.length = 0;
      const token = "Bearer test-token-abc123";
      await via({ path: "/api/health", headers: { authorization: token } });
      assert.equal(captured.length, 1);
      assert.equal(
        captured[0].headers["authorization"],
        token,
        "Authorization header not forwarded or was altered"
      );
    });

    // 3d. Response headers from stub reach the client
    await test("Response headers from stub are forwarded to the client", async () => {
      captured.length = 0;
      const res = await via({
        path: "/api/data",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(
        res.headers["x-custom-resp"],
        "yes",
        "Custom response header was not forwarded to the client"
      );
    });

    // 3e. Downstream disconnect before upstream acceptance → upstream request/socket closes
    await test("downstream disconnect before upstream acceptance aborts the owned upstream request", async () => {
      let unexpectedResponse = false;
      const downstream = http.request({
        hostname: "127.0.0.1",
        port: staticPort,
        path: "/api/upload",
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "1048576",
        },
      });
      const downstreamClosed = new Promise((resolvePromise) => {
        downstream.once("close", resolvePromise);
        downstream.once("error", resolvePromise);
      });
      downstream.on("response", (res) => {
        unexpectedResponse = true;
        res.resume();
      });

      downstream.write(Buffer.from("partial upload"));
      await waitFor(() => uploadRequestAccepted);
      downstream.destroy();
      await downstreamClosed;
      assert.equal(unexpectedResponse, false, "downstream request unexpectedly received a response");
      await waitFor(() => uploadRequestClosed && uploadRequestSocketClosed);
      assert.equal(
        uploadRequestCompleted,
        false,
        "upstream request unexpectedly completed its body before disconnect",
      );
    });

    // 3f. Downstream disconnect after response streaming begins → upstream response/socket closes
    await test("downstream disconnect after response chunks begin aborts the upstream response", async () => {
      let downstreamResponse;
      const downstream = http.get({
        hostname: "127.0.0.1",
        port: staticPort,
        path: "/api/stream",
      });
      const downstreamClosed = new Promise((resolvePromise, rejectPromise) => {
        downstream.once("close", resolvePromise);
        downstream.once("error", rejectPromise);
      });
      downstream.once("response", (res) => {
        downstreamResponse = res;
        res.once("data", () => downstream.destroy());
        res.on("error", () => {});
      });
      await waitFor(() => streamChunkSent);
      await downstreamClosed;
      await waitFor(() => streamResponseClosed && streamRequestSocketClosed);
      assert.ok(downstreamResponse, "downstream did not receive response headers");

      const health = await via({ path: "/api/health" });
      assert.equal(health.status, 200, "proxy did not serve a subsequent request");
    });

    // 3g. Active chunks must re-arm the response inactivity deadline.
    await test("active response chunks keep a valid stream alive past the initial timeout", async () => {
      const activeResponse = via({ path: "/api/active-stream", timeoutMs: 2_000 });
      await waitFor(() => activeStreamChunkSent);
      const idleResponse = await via({ path: "/api/stall", timeoutMs: 2_000 });
      const active = await activeResponse;

      assert.equal(active.status, 200, `expected active stream 200, got ${active.status}`);
      assert.match(active.body, /active response complete/);
      assert.equal(idleResponse.status, 504, `expected idle request 504, got ${idleResponse.status}`);
      await waitFor(() => stalledRequestReceived && stalledResponseClosed);
      assert.equal(activeStreamResponseClosed, true, "active stream did not close cleanly");
    });

    // 3h. Slow downstream consumption must not turn backpressure into an idle timeout.
    await test("slow downstream consumption preserves ordered chunks and releases sockets", async () => {
      const res = await sendSlowRequest({
        port: staticPort,
        path: "/api/backpressure-stream",
        delayMs: 220,
        timeoutMs: 5_000,
      });
      assert.equal(res.status, 200, `expected backpressure stream 200, got ${res.status}`);
      assert.equal(
        res.body,
        BACKPRESSURE_CHUNKS.join(""),
        "slow downstream consumer received missing, duplicated, or reordered chunks",
      );
      await waitFor(() => backpressureResponseClosed && backpressureRequestSocketClosed);
    });

    // 3i. Incomplete response → bounded downstream close and socket cleanup.
    await test("upstream close before completion closes downstream and releases sockets", async () => {
      const startedAt = Date.now();
      let downstreamClosed = false;
      const incomplete = http.get({
        hostname: "127.0.0.1",
        port: staticPort,
        path: "/api/incomplete",
      });
      const incompleteClosed = new Promise((resolvePromise, rejectPromise) => {
        incomplete.once("response", (res) => {
          res.resume();
          res.once("close", () => resolvePromise());
          res.on("error", () => {});
        });
        incomplete.once("close", () => {
          downstreamClosed = true;
        });
        incomplete.once("error", (error) => {
          if (!downstreamClosed) rejectPromise(error);
        });
      });
      await incompleteClosed;
      assert.ok(
        Date.now() - startedAt < 1_000,
        "incomplete upstream response was not bounded",
      );
      await waitFor(() => incompleteResponseClosed && incompleteRequestSocketClosed);

      const health = await via({ path: "/api/health" });
      assert.equal(health.status, 200, "proxy did not serve health after incomplete response");
    });

    // 3j. Incomplete response → bounded 504 JSON response and socket cleanup
    await test("stalled upstream → bounded 504 JSON response and socket cleanup", async () => {
      const res = await via({
        path: "/api/stall",
        timeoutMs: 2_000,
      });
      assert.equal(res.status, 504, `expected 504, got ${res.status}`);
      assert.deepEqual(JSON.parse(res.body), { error: "API server timed out" });
      await waitFor(() => stalledRequestReceived);
      await waitFor(() => stalledResponseClosed);
    });

    // 3k. Unexpected harness errors still clean up owned resources
    await test("unexpected harness errors still clean up owned resources", async () => {
      let probeServer;
      let probeChild;
      try {
        probeServer = (await listenRandom(() => {})).server;
        probeChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
          detached: true,
          stdio: "ignore",
        });
        await assert.rejects(
          (async () => {
            try {
              throw new Error("fixture harness failure");
            } finally {
              await stopChild(probeChild);
              await closeServer(probeServer);
            }
          })(),
          /fixture harness failure/,
        );
      } finally {
        await stopChild(probeChild);
        await closeServer(probeServer);
      }
      assert.equal(probeServer.listening, false, "harness error cleanup left the probe server listening");
      assert.ok(
        probeChild.exitCode !== null || probeChild.signalCode !== null,
        "harness error cleanup left the probe child running",
      );
    });

    // 3l. API server down → 502 JSON, serve.js stays alive
    await test("API server unavailable → 502 JSON response, serve.js stays alive", async () => {
      // Shut the stub down to simulate the API server being unreachable.
      await closeServer(stubServer);

      const res = await via({ path: "/api/health" });
      assert.equal(res.status, 502, `expected 502, got ${res.status}`);

      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new Error(`Response body is not valid JSON: ${JSON.stringify(res.body)}`);
      }
      assert.ok(
        typeof parsed.error === "string" && parsed.error.length > 0,
        `expected { error: "<string>" }, got ${JSON.stringify(parsed)}`
      );

      // Confirm serve.js itself did not crash.
      assert.equal(child.exitCode, null, "serve.js exited unexpectedly after a proxy error");
    });

    // ── 4. Report ───────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed`);
    exitCode = failed > 0 ? 1 : 0;
  } catch (err) {
    console.error(`\nUnhandled error in test harness: ${err.stack ?? err}`);
    exitCode = 1;
  } finally {
    await stopChild(child);
    await closeServer(stubServer);
    fs.rmSync(staticRoot, { recursive: true, force: true });
  }

  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error("\nFatal proxy harness failure:", err.stack ?? err);
  process.exitCode = 1;
});
