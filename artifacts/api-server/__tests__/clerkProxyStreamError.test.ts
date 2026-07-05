/**
 * Unit tests for the Clerk proxy streaming branch error handler in
 * clerkProxyMiddleware.
 *
 * The streaming branch is taken when the upstream response carries a known
 * Content-Length (or is body-less: HEAD / 1xx / 204 / 304).  It calls
 * `proxyRes.pipe(res)` after `res.writeHead(...)` has already been called.
 *
 * If the upstream socket resets mid-stream (ECONNRESET) an "error" event is
 * emitted on proxyRes.  The handler must call `res.destroy()` so the client
 * gets a hard close rather than a hung connection, and must NOT let the error
 * propagate as an unhandled rejection / uncaught exception.
 *
 * Scenarios covered:
 *  1. ECONNRESET on a Content-Length response → res.destroy() called, no
 *     unhandled error thrown.
 *  2. ECONNRESET on a body-less HEAD response → same guarantee.
 *  3. Happy path: a clean Content-Length response is piped without calling
 *     res.destroy().
 */

// ── Mock http-proxy-middleware ────────────────────────────────────────────────
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
import { clerkProxyMiddleware } from "../src/middlewares/clerkProxyMiddleware";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A proxyRes fake that takes the STREAMING path (has a content-length header).
 * pipe() is stubbed so no real piping happens.
 */
function makeStreamingProxyRes(
  statusCode = 200,
  contentLength = "42",
): EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  pipe: jest.Mock;
  destroy: jest.Mock;
} {
  const ee = new EventEmitter() as any;
  ee.statusCode = statusCode;
  ee.headers = { "content-length": contentLength };
  ee.pipe = jest.fn(); // prevent real piping
  ee.destroy = jest.fn((err?: Error) => {
    if (err) ee.emit("error", err);
  });
  return ee;
}

/**
 * A proxyRes fake for body-less responses (HEAD / 204 etc.).
 * No content-length, but bodyless flag causes the streaming branch.
 */
function makeBodylessProxyRes(statusCode = 204): EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  pipe: jest.Mock;
  destroy: jest.Mock;
} {
  const ee = new EventEmitter() as any;
  ee.statusCode = statusCode;
  ee.headers = {}; // no content-length, but bodyless → streaming branch
  ee.pipe = jest.fn();
  ee.destroy = jest.fn((err?: Error) => {
    if (err) ee.emit("error", err);
  });
  return ee;
}

/** Minimal ServerResponse-like fake (headers already sent — writeHead was called). */
function makeFakeRes() {
  return {
    headersSent: false as boolean,
    writeHead: jest.fn(function (this: any) {
      this.headersSent = true;
    }),
    end: jest.fn(),
    destroy: jest.fn(),
  };
}

/** Minimal client-side IncomingMessage fake. */
const fakeGetReq = { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } };
const fakeHeadReq = { method: "HEAD", headers: {}, socket: { remoteAddress: "127.0.0.1" } };

// ── Test suite ────────────────────────────────────────────────────────────────

describe("clerkProxyMiddleware — streaming branch error handling", () => {
  let proxyResHandler: (proxyRes: any, req: any, res: any) => void;

  beforeAll(() => {
    process.env.NODE_ENV = "production";
    process.env.CLERK_SECRET_KEY = "sk_test_fake";

    clerkProxyMiddleware();

    const mockFn = createProxyMiddleware as jest.Mock;
    expect(mockFn.mock.calls.length).toBeGreaterThan(0);
    const options = mockFn.mock.calls[0][0];
    proxyResHandler = options.on.proxyRes;
  });

  afterAll(() => {
    process.env.NODE_ENV = "test";
    delete process.env.CLERK_SECRET_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Scenario 1: ECONNRESET on a Content-Length response ────────────────────
  describe("when the upstream socket resets mid-stream on a Content-Length response", () => {
    it("calls res.destroy() so the client gets a hard close", () => {
      const proxyRes = makeStreamingProxyRes(200, "42");
      const res = makeFakeRes();

      proxyResHandler(proxyRes, fakeGetReq, res);

      // Verify we took the streaming branch: writeHead was called, pipe was called.
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-length": "42" }));
      expect(proxyRes.pipe).toHaveBeenCalledWith(res);

      // Now simulate the upstream socket reset.
      proxyRes.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));

      expect(res.destroy).toHaveBeenCalled();
    });

    it("does not propagate the error as an unhandled exception", () => {
      const proxyRes = makeStreamingProxyRes(200, "42");
      const res = makeFakeRes();

      proxyResHandler(proxyRes, fakeGetReq, res);

      const uncaughtSpy = jest.fn();
      process.once("uncaughtException", uncaughtSpy);

      // Emit the error; must not reach the process-level handler.
      expect(() => {
        proxyRes.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      }).not.toThrow();

      // Give the event loop a tick; if the error bubbled up the spy would fire.
      process.removeListener("uncaughtException", uncaughtSpy);
      expect(uncaughtSpy).not.toHaveBeenCalled();
    });
  });

  // ── Scenario 2: ECONNRESET on a body-less (HEAD) response ─────────────────
  describe("when the upstream socket resets mid-stream on a body-less HEAD response", () => {
    it("calls res.destroy() and does not throw", () => {
      const proxyRes = makeBodylessProxyRes(200);
      const res = makeFakeRes();

      proxyResHandler(proxyRes, fakeHeadReq, res);

      // HEAD is bodyless → streaming branch.
      expect(res.writeHead).toHaveBeenCalled();
      expect(proxyRes.pipe).toHaveBeenCalledWith(res);

      expect(() => {
        proxyRes.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      }).not.toThrow();

      expect(res.destroy).toHaveBeenCalled();
    });
  });

  // ── Scenario 3: happy path — no error, pipe is called normally ─────────────
  describe("when the upstream Content-Length response completes cleanly", () => {
    it("does not call res.destroy()", () => {
      const proxyRes = makeStreamingProxyRes(200, "5");
      const res = makeFakeRes();

      proxyResHandler(proxyRes, fakeGetReq, res);

      // No error emitted.
      expect(res.destroy).not.toHaveBeenCalled();
      expect(proxyRes.pipe).toHaveBeenCalledWith(res);
    });
  });
});
