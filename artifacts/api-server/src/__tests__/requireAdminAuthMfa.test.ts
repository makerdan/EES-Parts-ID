/**
 * Unit tests for the MFA enforcement logic in requireAdminAuth.
 *
 * These tests exercise the middleware function directly (not through the full
 * Express app) to isolate the MFA claim-checking logic from the DB and Clerk
 * API layers. The fast path (res.locals.appUser already set by requireAppAuth)
 * is used so no database round-trip is needed.
 *
 * Three cases per the task spec:
 *   (a) Admin session WITH a recognised MFA amr claim + ENFORCE_ADMIN_MFA=true → passes (next() called)
 *   (b) Admin session WITHOUT MFA amr claim      + ENFORCE_ADMIN_MFA=true → 403 MFA_REQUIRED
 *   (c) ENFORCE_ADMIN_MFA unset                  → passes regardless of amr (backward-compat default)
 */

import { type NextFunction, type Request, type Response } from "express";

// ── Mock @clerk/express before importing the middleware ────────────────────────
// Override the global moduleNameMapper stub so we can inject sessionClaims.
let mockSessionClaims: Record<string, unknown> | null = null;

jest.mock("@clerk/express", () => ({
  getAuth: (_req: Request) => ({
    userId: "jest-mfa-admin-user",
    sessionClaims: mockSessionClaims,
  }),
  clerkClient: { users: { getUser: jest.fn() } },
  clerkMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub the DB so the middleware never reaches a real database. These tests use
// the fast path (appUser pre-populated in res.locals), so the DB is not called,
// but the import must still resolve.
jest.mock("@workspace/db", () => ({
  db: { select: jest.fn() },
  usersTable: { clerkUserId: "clerkUserId", role: "role" },
}));

jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
}));

import { requireAdminAuth } from "../middlewares/requireAdminAuth";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMocks(role: "admin" | "user" | undefined = "admin") {
  const req = {
    path: "/test",
    method: "GET",
    headers: { authorization: "Bearer jest-mfa-admin-user" },
  } as unknown as Request;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = {
    locals: {
      appUser: { clerkUserId: "jest-mfa-admin-user", role },
      isBootstrapAdmin: false,
    },
    status,
    json,
  } as unknown as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next, json, status };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("requireAdminAuth — MFA enforcement", () => {
  const ORIGINAL_ENFORCE = process.env.ENFORCE_ADMIN_MFA;

  afterEach(() => {
    // Restore env between tests.
    if (ORIGINAL_ENFORCE === undefined) {
      delete process.env.ENFORCE_ADMIN_MFA;
    } else {
      process.env.ENFORCE_ADMIN_MFA = ORIGINAL_ENFORCE;
    }
    mockSessionClaims = null;
  });

  it("(a) passes when admin session includes totp amr claim and ENFORCE_ADMIN_MFA=true", () => {
    process.env.ENFORCE_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd", "totp"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(a) passes when admin session includes phone_code amr claim and ENFORCE_ADMIN_MFA=true", () => {
    process.env.ENFORCE_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd", "phone_code"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(b) returns 403 MFA_REQUIRED when amr is absent and ENFORCE_ADMIN_MFA=true", () => {
    process.env.ENFORCE_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const responseBody = (res.status as jest.Mock).mock.results[0].value;
    expect(responseBody.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MFA_REQUIRED" }),
    );
  });

  it("(b) returns 403 MFA_REQUIRED when sessionClaims is null and ENFORCE_ADMIN_MFA=true", () => {
    process.env.ENFORCE_ADMIN_MFA = "true";
    mockSessionClaims = null;

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const responseBody = (res.status as jest.Mock).mock.results[0].value;
    expect(responseBody.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MFA_REQUIRED" }),
    );
  });

  it("(c) passes without MFA when ENFORCE_ADMIN_MFA is unset (backward-compatible default)", () => {
    delete process.env.ENFORCE_ADMIN_MFA;
    mockSessionClaims = { amr: ["pwd"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(c) passes without MFA when ENFORCE_ADMIN_MFA=false", () => {
    process.env.ENFORCE_ADMIN_MFA = "false";
    mockSessionClaims = null;

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("non-admin users are rejected with 403 regardless of MFA settings", () => {
    process.env.ENFORCE_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd", "totp"] };

    const { req, res, next } = buildMocks("user");
    requireAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const responseBody = (res.status as jest.Mock).mock.results[0].value;
    expect(responseBody.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Admin access required" }),
    );
  });
});
