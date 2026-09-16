/**
 * Unit tests for the MFA enforcement logic in requireAdminAuth.
 *
 * These tests exercise the middleware function directly (not through the full
 * Express app) to isolate the MFA claim-checking logic from the DB and Clerk
 * API layers. The fast path (res.locals.appUser already set by requireAppAuth)
 * is used so no database round-trip is needed.
 *
 * MFA is enforced by default. Three cases:
 *   (a) Admin session WITH a recognised MFA amr claim (default) → passes (next() called)
 *   (b) Admin session WITHOUT MFA amr claim (default)           → 403 MFA_REQUIRED
 *   (c) SKIP_ADMIN_MFA=true                                     → passes regardless of amr
 */

import { type NextFunction, type Request, type Response } from "express";

// ── Mock @clerk/express before importing the middleware ────────────────────────
// Override the global moduleNameMapper stub so we can inject sessionClaims.
let mockSessionClaims: Record<string, unknown> | null = null;
let mockUserId: string | null = "jest-mfa-admin-user";

jest.mock("@clerk/express", () => ({
  getAuth: (_req: Request) => ({
    userId: mockUserId,
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

import { requireAdminAuth, requireApprovedAdminAuth } from "../middlewares/requireAdminAuth";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMocks(
  role: "admin" | "user" | undefined = "admin",
  accountStatus = "approved",
  includeAppUser = true,
) {
  const req = {
    path: "/test",
    method: "GET",
    headers: { authorization: "Bearer jest-mfa-admin-user" },
  } as unknown as Request;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = {
    locals: {
      ...(includeAppUser
        ? { appUser: { clerkUserId: "jest-mfa-admin-user", status: accountStatus, role } }
        : {}),
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
  const ORIGINAL_SKIP = process.env.SKIP_ADMIN_MFA;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    // Restore env between tests.
    if (ORIGINAL_SKIP === undefined) {
      delete process.env.SKIP_ADMIN_MFA;
    } else {
      process.env.SKIP_ADMIN_MFA = ORIGINAL_SKIP;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    mockSessionClaims = null;
    mockUserId = "jest-mfa-admin-user";
  });

  it("(a) passes when admin session includes totp amr claim (MFA enforced by default)", () => {
    delete process.env.SKIP_ADMIN_MFA;
    mockSessionClaims = { amr: ["pwd", "totp"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(a) passes when admin session includes phone_code amr claim (MFA enforced by default)", () => {
    delete process.env.SKIP_ADMIN_MFA;
    mockSessionClaims = { amr: ["pwd", "phone_code"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(b) returns 403 MFA_REQUIRED when amr is absent (MFA enforced by default)", () => {
    delete process.env.SKIP_ADMIN_MFA;
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

  it("(b) returns 403 MFA_REQUIRED when sessionClaims is null (MFA enforced by default)", () => {
    delete process.env.SKIP_ADMIN_MFA;
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

  it("(c) passes without MFA when SKIP_ADMIN_MFA=true", () => {
    process.env.SKIP_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd"] };

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("(c) passes without MFA when SKIP_ADMIN_MFA=true and sessionClaims is null", () => {
    process.env.SKIP_ADMIN_MFA = "true";
    mockSessionClaims = null;

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("fails closed in production even when SKIP_ADMIN_MFA=true", () => {
    process.env.NODE_ENV = "production";
    process.env.SKIP_ADMIN_MFA = "true";
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

  it("non-admin users are rejected with 403 regardless of MFA settings", () => {
    delete process.env.SKIP_ADMIN_MFA;
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

  describe("requireApprovedAdminAuth — narrowly scoped approved-admin exception", () => {
    it("allows an approved admin without an MFA claim", () => {
      mockSessionClaims = { amr: ["pwd"] };

      const { req, res, next } = buildMocks("admin");
      requireApprovedAdminAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each([
      ["approved non-admin", "user", "approved"],
      ["pending admin", "admin", "pending"],
      ["banned admin", "admin", "banned"],
    ] as const)("%s is rejected without MFA", (_label, role, status) => {
      mockSessionClaims = { amr: ["pwd"] };

      const { req, res, next } = buildMocks(role, status);
      requireApprovedAdminAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      const responseBody = (res.status as jest.Mock).mock.results[0].value;
      expect(responseBody.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Admin access required" }),
      );
    });

    it("rejects an unauthenticated request before checking the database", () => {
      mockUserId = null;

      const { req, res, next } = buildMocks("admin", "approved", false);
      requireApprovedAdminAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      const responseBody = (res.status as jest.Mock).mock.results[0].value;
      expect(responseBody.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Authentication required" }),
      );
    });

    it("does not weaken the default guard used by unrelated admin operations", () => {
      mockSessionClaims = { amr: ["pwd"] };

      const exception = buildMocks("admin");
      requireApprovedAdminAuth(exception.req, exception.res, exception.next);
      expect(exception.next).toHaveBeenCalledTimes(1);

      const defaultGuard = buildMocks("admin");
      requireAdminAuth(defaultGuard.req, defaultGuard.res, defaultGuard.next);
      expect(defaultGuard.next).not.toHaveBeenCalled();
      expect(defaultGuard.res.status).toHaveBeenCalledWith(403);
    });
  });
});
