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
 *   ✓ API server down → 502 JSON response, serve.js does not crash.
 *
 * Exit: 0 on all-pass, 1 on any failure.
 */

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_JS = resolve(__dirname, "..", "server", "serve.js");

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Start an HTTP server on a random OS-assigned port. Returns { server, port }. */
function listenRandom(handler) {
  return new Promise((ok, fail) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (srv.address());
      ok({ server: srv, port });
    });
    srv.on("error", fail);
  });
}

/** Gracefully close an HTTP server. */
function closeServer(srv) {
  return new Promise((ok) => srv.close(ok));
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
    const attempt = () => {
      if (Date.now() > deadline) {
        return fail(new Error(`Port ${port} never opened within ${timeoutMs} ms`));
      }
      const sock = net.createConnection(port, "127.0.0.1");
      sock.on("connect", () => { sock.destroy(); ok(); });
      sock.on("error", () => { sock.destroy(); setTimeout(attempt, 80); });
    };
    attempt();
  });
}

/**
 * Send an HTTP request and resolve with { status, headers, body }.
 * @param {{ port: number; path: string; method?: string; headers?: Record<string,string>; body?: string }} opts
 */
function sendRequest(opts) {
  return new Promise((ok, fail) => {
    const payload = opts.body != null ? Buffer.from(opts.body) : undefined;
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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        ok({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
    });
    req.on("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
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

  const { server: stubServer, port: stubPort } = await listenRandom((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      captured.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: bodyStr,
      });

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

  // ── 2. Pick a port for the static server, then spawn serve.js ───────────
  const staticPort = await pickFreePort();

  const child = spawn("node", [SERVE_JS], {
    env: {
      ...process.env,
      PORT: String(staticPort),
      API_SERVER_PORT: String(stubPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) process.stderr.write(`  [serve.js] ${msg}\n`);
  });

  try {
    await waitForPort(staticPort, 5000);
  } catch (err) {
    child.kill("SIGTERM");
    await closeServer(stubServer);
    console.error(`\nFATAL: serve.js did not start — ${err.message}`);
    process.exit(1);
  }

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

  // 3e. API server down → 502 JSON, serve.js stays alive
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

  // ── 4. Cleanup ────────────────────────────────────────────────────────────
  child.kill("SIGTERM");
  await new Promise((ok) => child.on("exit", ok));

  // ── 5. Report ─────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nUnhandled error in test harness:", err);
  process.exit(1);
});
