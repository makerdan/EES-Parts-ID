/**
 * Regression coverage proving MFA claims are irrelevant to admin
 * authorization.
 *
 * The middleware exercised here (`requireAdminAuth`, `requireApprovedAdminAuth`,
 * `hasCurrentAdminAccess`) used to reject an otherwise-approved admin whose
 * Clerk session lacked a recognised second-factor (`amr`) claim, returning
 * `403 { code: "MFA_REQUIRED" }` unless `SKIP_ADMIN_MFA=true` was set. That
 * enforcement and its bypass have been removed entirely: an authenticated,
 * approved administrator is admitted regardless of session MFA claims, and no
 * environment variable changes that outcome. Every other authorization state
 * (unauthenticated, pending, banned, non-admin) must remain rejected exactly
 * as before.
 */

import { type NextFunction, type Request, type Response } from "express";

// ── Mock @clerk/express before importing the middleware ────────────────────────
// Override the global moduleNameMapper stub so we can inject sessionClaims.
let mockSessionClaims: Record<string, unknown> | null = null;
let mockUserId: string | null = "jest-mfa-admin-user";
let mockDbRows: Array<{ role: string; status: string }> = [];

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
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => mockDbRows),
        })),
      })),
    })),
  },
  usersTable: { clerkUserId: "clerkUserId", role: "role", status: "status" },
}));

jest.mock("drizzle-orm", () => ({
  eq: jest.fn(),
}));

import {
  hasCurrentAdminAccess,
  requireAdminAuth,
  requireApprovedAdminAuth,
} from "../middlewares/requireAdminAuth";

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

describe("requireAdminAuth / requireApprovedAdminAuth — MFA claims are irrelevant", () => {
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
    mockDbRows = [];
  });

  it.each([
    ["a completed MFA amr claim", { amr: ["pwd", "totp"] }],
    ["a phone_code amr claim", { amr: ["pwd", "phone_code"] }],
    ["no second factor at all", { amr: ["pwd"] }],
    ["null sessionClaims", null],
  ] as const)("requireAdminAuth passes an approved admin with %s", (_label, claims) => {
    mockSessionClaims = claims;

    const { req, res, next } = buildMocks("admin");
    requireAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("never returns the MFA_REQUIRED response shape, with or without SKIP_ADMIN_MFA set", () => {
    for (const skip of [undefined, "true", "false"]) {
      if (skip === undefined) delete process.env.SKIP_ADMIN_MFA;
      else process.env.SKIP_ADMIN_MFA = skip;
      mockSessionClaims = { amr: ["pwd"] };

      const { req, res, next, status } = buildMocks("admin");
      requireAdminAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalledWith(403);
    }
  });

  it("requireApprovedAdminAuth also admits an approved admin without an MFA claim", () => {
    mockSessionClaims = { amr: ["pwd"] };

    const { req, res, next } = buildMocks("admin");
    requireApprovedAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("SKIP_ADMIN_MFA has no effect on the outcome for a non-admin", () => {
    process.env.SKIP_ADMIN_MFA = "true";
    mockSessionClaims = { amr: ["pwd", "totp"] };

    const { req, res, next } = buildMocks("user", "approved");
    requireAdminAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  describe.each([
    ["requireAdminAuth", requireAdminAuth],
    ["requireApprovedAdminAuth", requireApprovedAdminAuth],
  ] as const)("%s — other authorization states remain enforced", (_name, guard) => {
    it.each([
      ["approved non-admin", "user", "approved"],
      ["pending admin", "admin", "pending"],
      ["banned admin", "admin", "banned"],
    ] as const)("%s is rejected with 403 regardless of MFA claims", (_label, role, status) => {
      mockSessionClaims = { amr: ["pwd", "totp"] };

      const { req, res, next } = buildMocks(role, status);
      guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      const responseBody = (res.status as jest.Mock).mock.results[0].value;
      expect(responseBody.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Admin access required" }),
      );
    });

    it("rejects an unauthenticated request with 401 before checking MFA or role", () => {
      mockUserId = null;

      const { req, res, next } = buildMocks("admin", "approved", false);
      guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      const responseBody = (res.status as jest.Mock).mock.results[0].value;
      expect(responseBody.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Authentication required" }),
      );
    });
  });

  describe("hasCurrentAdminAccess", () => {
    it("allows an approved admin without any MFA claim", async () => {
      mockSessionClaims = { amr: ["pwd"] };
      mockDbRows = [{ role: "admin", status: "approved" }];

      const { req } = buildMocks("admin");
      await expect(hasCurrentAdminAccess(req)).resolves.toBe(true);
    });

    it.each([
      ["non-admin", "user", "approved"],
      ["pending admin", "admin", "pending"],
      ["banned admin", "admin", "banned"],
    ] as const)("%s remains blocked even with a completed MFA claim", async (_label, role, status) => {
      mockSessionClaims = { amr: ["pwd", "totp"] };
      mockDbRows = [{ role, status }];

      const { req } = buildMocks("admin");
      await expect(hasCurrentAdminAccess(req)).resolves.toBe(false);
    });

    it("rejects an unauthenticated request", async () => {
      mockUserId = null;

      const { req } = buildMocks("admin");
      await expect(hasCurrentAdminAccess(req)).resolves.toBe(false);
    });
  });
});
