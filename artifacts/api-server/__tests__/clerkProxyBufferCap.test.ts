/**
 * Unit tests for the Clerk proxy buffer-cap protection in clerkProxyMiddleware.
 *
 * The buffer-cap guard destroys the upstream proxyRes stream when the
 * accumulated body exceeds 10 MB.  That destruction emits an "error" event
 * which the error handler must handle cleanly regardless of whether the client
 * response headers have already been sent.
 *
 * Scenarios covered:
 *  1. Cap exceeded, headers NOT yet sent → client receives a 502.
 *  2. Cap exceeded, headers already sent → res.destroy() is called so the
 *     client gets a hard close instead of a hung connection.
 *  3. logger.warn is called with the bytes count when the cap fires.
 *
 * We mock http-proxy-middleware so that createProxyMiddleware captures the
 * options and we can invoke the proxyRes callback directly without a real
 * HTTP server.  We also force NODE_ENV=production + a fake CLERK_SECRET_KEY
 * so the real middleware path (not the dev-mode passthrough) is exercised.
 */

// ── Mock http-proxy-middleware ────────────────────────────────────────────────
// jest.mock is hoisted; the factory must be self-contained (no outer-scope
// variable references).  We return a jest.fn() so we can retrieve the options
// via .mock.calls[0][0] after clerkProxyMiddleware() is called.
jest.mock("http-proxy-middleware", () => {
  const fn = jest.fn((_options: any) => (_req: any, _res: any, next: any) => next());
  return { createProxyMiddleware: fn };
});

// ── Mock logger ───────────────────────────────────────────────────────────────
jest.mock("../src/lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { EventEmitter } from "events";
import { createProxyMiddleware } from "http-proxy-middleware";
import { logger } from "../src/lib/logger";

// clerkProxyMiddleware must be imported AFTER the mocks are in place.
// Because jest.mock is hoisted, the import order here doesn't actually matter
// for the mocks, but keeping it last makes the intent clear.
import { clerkProxyMiddleware } from "../src/middlewares/clerkProxyMiddleware";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal IncomingMessage-like fake that is also an EventEmitter. */
function makeFakeProxyRes(statusCode = 200): EventEmitter & { statusCode: number; headers: Record<string, string> } {
  const ee = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    destroy: jest.Mock;
  };
  ee.statusCode = statusCode;
  ee.headers = {}; // no content-length → triggers the buffering path
  ee.destroy = jest.fn((err?: Error) => {
    // Simulate Node.js stream behaviour: destroy emits "error" then "close".
    if (err) {
      ee.emit("error", err);
    }
  });
  return ee;
}

/** Minimal ServerResponse-like fake. */
function makeFakeRes(headersSent = false) {
  return {
    headersSent,
    writeHead: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  };
}

/** Minimal IncomingMessage-like fake (the client request, not the proxy response). */
const fakeReq = {
  method: "GET",
  headers: {},
  socket: { remoteAddress: "127.0.0.1" },
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe("clerkProxyMiddleware — buffer cap protection", () => {
  let proxyResHandler: (proxyRes: any, req: any, res: any) => void;

  beforeAll(() => {
    // Set env so the active proxy branch runs (not the dev passthrough).
    process.env.NODE_ENV = "production";
    process.env.CLERK_SECRET_KEY = "sk_test_fake";

    // Calling clerkProxyMiddleware() triggers createProxyMiddleware(options).
    // We capture the options from the mock's recorded call.
    clerkProxyMiddleware();

    const mockFn = createProxyMiddleware as jest.Mock;
    expect(mockFn.mock.calls.length).toBeGreaterThan(0);
    const options = mockFn.mock.calls[0][0];
    proxyResHandler = options.on.proxyRes;
  });

  afterAll(() => {
    // Restore env so other suites are unaffected.
    process.env.NODE_ENV = "test";
    delete process.env.CLERK_SECRET_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Scenario 1: headers not yet sent ───────────────────────────────────────
  describe("when the buffer cap is exceeded before headers are sent", () => {
    it("sends a 502 to the client", () => {
      const proxyRes = makeFakeProxyRes();
      const res = makeFakeRes(false); // headersSent = false

      proxyResHandler(proxyRes, fakeReq, res);

      // Emit a chunk that pushes us over the 10 MB cap in one go.
      const bigChunk = Buffer.alloc(10 * 1024 * 1024 + 1);
      proxyRes.emit("data", bigChunk);

      expect(res.writeHead).toHaveBeenCalledWith(502, { "content-length": "0" });
      expect(res.end).toHaveBeenCalled();
      expect(res.destroy).not.toHaveBeenCalled();
    });

    it("logs a warning with the byte count", () => {
      const proxyRes = makeFakeProxyRes();
      const res = makeFakeRes(false);

      proxyResHandler(proxyRes, fakeReq, res);

      const bigChunk = Buffer.alloc(10 * 1024 * 1024 + 1);
      proxyRes.emit("data", bigChunk);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: expect.any(Number) }),
        expect.stringContaining("buffer cap"),
      );
    });
  });

  // ── Scenario 2: headers already sent ──────────────────────────────────────
  describe("when the buffer cap is exceeded after headers have already been sent", () => {
    it("calls res.destroy() instead of res.end() to close the socket", () => {
      const proxyRes = makeFakeProxyRes();
      const res = makeFakeRes(true); // headersSent = true

      proxyResHandler(proxyRes, fakeReq, res);

      const bigChunk = Buffer.alloc(10 * 1024 * 1024 + 1);
      proxyRes.emit("data", bigChunk);

      // Must not try to write a new status line (would throw on a real response).
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalled();
    });

    it("still logs a warning with the byte count", () => {
      const proxyRes = makeFakeProxyRes();
      const res = makeFakeRes(true);

      proxyResHandler(proxyRes, fakeReq, res);

      const bigChunk = Buffer.alloc(10 * 1024 * 1024 + 1);
      proxyRes.emit("data", bigChunk);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: expect.any(Number) }),
        expect.stringContaining("buffer cap"),
      );
    });
  });

  // ── Scenario 3: normal response (below cap) still flows through ───────────
  describe("when the response is within the buffer cap", () => {
    it("forwards the body with a Content-Length header", () => {
      const proxyRes = makeFakeProxyRes(200);
      const res = makeFakeRes(false);

      proxyResHandler(proxyRes, fakeReq, res);

      const smallChunk = Buffer.from("hello");
      proxyRes.emit("data", smallChunk);
      proxyRes.emit("end");

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        "content-length": "5",
      }));
      expect(res.end).toHaveBeenCalledWith(Buffer.from("hello"));
      expect(res.destroy).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
