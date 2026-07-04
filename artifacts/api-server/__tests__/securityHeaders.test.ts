/**
 * Smoke tests verifying that HTTP security headers are present on every
 * API response.  These headers are injected by helmet, which is mounted
 * before CORS and body parsers in app.ts.
 *
 * Covered headers:
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Content-Security-Policy: contains default-src 'none'
 * - Strict-Transport-Security is NOT expected in test env (NODE_ENV !== "production")
 *
 * The routes module is fully stubbed to avoid loading ESM-only transitive
 * dependencies (uuid@14 via exceljs and @google-cloud/storage) that break
 * Jest's CJS transform mode.  Helmet runs before any route handler, so the
 * stub is sufficient to exercise the middleware stack under test.
 */

// ── Routes stub — bypasses all ESM-incompatible transitive deps ──────────────
// jest.mock is hoisted; define the router inside the factory to avoid TDZ.
jest.mock("../src/routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Router } = require("express");
  const r = Router();
  // Express 5 path-to-regexp v8 rejects bare "*" — use a catch-all middleware instead.
  r.use((_req: any, res: any) => {
    res.status(401).json({ error: "Authentication required" });
  });
  return r;
});

// ── requireAppAuth mock ───────────────────────────────────────────────────────
jest.mock("../src/middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: any, _res: any, next: any): void => next(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HTTP security headers (helmet)", () => {
  let res: Awaited<ReturnType<ReturnType<typeof supertest>>>;

  beforeAll(async () => {
    res = await supertest(app).get("/api/inventory");
  });

  it("sets X-Content-Type-Options: nosniff", () => {
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", () => {
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets Referrer-Policy: strict-origin-when-cross-origin", () => {
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets Content-Security-Policy with default-src 'none'", () => {
    const csp: string = res.headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
  });

  it("does NOT set Strict-Transport-Security in non-production", () => {
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});
