/**
 * Integration tests for the bootstrap-admin user approval flow.
 *
 * Covers the full lifecycle a new sign-up goes through:
 *   1. New user is inserted as `pending` by requireAppAuth on first request.
 *   2. Bootstrap admin lists pending users via GET /admin/users.
 *   3. Admin approves the user — user immediately gains API access (200).
 *   4. Admin bans a different user — that user receives 403 { code: "banned" }.
 *
 * Auth model (from __mocks__/clerkExpress.cjs):
 *   The Bearer token value IS the Clerk user id; requireAppAuth uses it
 *   directly. The bootstrap admin's id matches ADMIN_CLERK_USER_ID, which is
 *   set as a side-effect of importing adminAuth.ts.
 */

// ── OpenAI constructor mock (loaded transitively by AI routes at module init) ─
const mockCompletionsCreate = jest.fn().mockResolvedValue({
  id: "chatcmpl-mock",
  choices: [{ message: { role: "assistant", content: "hi" } }],
});

class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation(() => ({
    chat: { completions: { create: mockCompletionsCreate } },
  }));

(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError =
  MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError =
  MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError =
  MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError =
  MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError =
  MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError =
  MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

// ── Standard workspace mocks ──────────────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { like } from "drizzle-orm";

import app from "../app";
import { ADMIN_TEST_USER_ID } from "../../__tests__/helpers/adminAuth";
import { db, usersTable } from "@workspace/db";

// ── Fixed test Clerk user ids ─────────────────────────────────────────────────
// All ids share the "jest-approval-" prefix so the afterAll cleanup can
// remove them with a single LIKE query without touching unrelated rows.
const PENDING_USER   = "jest-approval-pending";
const TO_BAN_USER    = "jest-approval-tobanned";
const NON_ADMIN_USER = "jest-approval-nonadmin";

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Bearer header for the bootstrap admin. */
function adminBearer(): string {
  return `Bearer ${ADMIN_TEST_USER_ID}`;
}

/** Bearer header for an arbitrary non-admin user. */
function nonAdminBearer(): string {
  return `Bearer ${NON_ADMIN_USER}`;
}

// ── Seed / teardown ───────────────────────────────────────────────────────────
beforeAll(async () => {
  // Seed a pending user and a to-be-banned user directly so tests do not
  // depend on an outbound Clerk API call from requireAppAuth.
  await db
    .insert(usersTable)
    .values([
      {
        clerkUserId: PENDING_USER,
        email: "pending@test.example",
        status: "pending",
        role: "user",
      },
      {
        clerkUserId: TO_BAN_USER,
        email: "tobanned@test.example",
        status: "pending",
        role: "user",
      },
      {
        clerkUserId: NON_ADMIN_USER,
        email: "nonadmin@test.example",
        status: "approved",
        role: "user",
      },
    ])
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: "pending", role: "user", updatedAt: new Date() },
    });
});

afterAll(async () => {
  await db
    .delete(usersTable)
    .where(like(usersTable.clerkUserId, "jest-approval-%"));
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Auth guards — GET /api/admin/users
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — auth guards", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved but non-admin user", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", nonAdminBearer())
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users — pending queue visibility
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — pending queue", () => {
  it("lists all users including seeded pending users", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", adminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("users");
    expect(Array.isArray(res.body.users)).toBe(true);

    const ids: string[] = res.body.users.map(
      (u: { clerkUserId: string }) => u.clerkUserId,
    );
    expect(ids).toContain(PENDING_USER);
    expect(ids).toContain(TO_BAN_USER);
  });

  it("includes status and email fields for each user", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", adminBearer())
      .expect(200);

    const pending = res.body.users.find(
      (u: { clerkUserId: string }) => u.clerkUserId === PENDING_USER,
    );
    expect(pending).toBeDefined();
    expect(pending.status).toBe("pending");
    expect(typeof pending.email).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth guards — POST /api/admin/users/:id/approve and :id/ban
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/approve — auth guards", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PENDING_USER}/approve`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved but non-admin user", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PENDING_USER}/approve`)
      .set("Authorization", nonAdminBearer())
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/admin/users/:id/ban — auth guards", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${TO_BAN_USER}/ban`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved but non-admin user", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${TO_BAN_USER}/ban`)
      .set("Authorization", nonAdminBearer())
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Approve flow: pending → approved → can access the app
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/approve — approval flow", () => {
  it("returns 200 with the updated user record showing status=approved", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PENDING_USER}/approve`)
      .set("Authorization", adminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.clerkUserId).toBe(PENDING_USER);
    expect(res.body.user.status).toBe("approved");
  });

  it("newly approved user can access a protected API endpoint (not 403)", async () => {
    // GET /api/admin/me only requires app-level auth (requireAppAuth), not
    // admin auth, so it's a clean signal that the user passed the approval gate.
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${PENDING_USER}`)
      .expect(200);

    expect(res.body).toHaveProperty("isAdmin");
    expect(res.body.isAdmin).toBe(false);
  });

  it("approved user no longer appears as pending in the user list", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", adminBearer())
      .expect(200);

    const record = res.body.users.find(
      (u: { clerkUserId: string }) => u.clerkUserId === PENDING_USER,
    );
    expect(record).toBeDefined();
    expect(record.status).toBe("approved");
  });

  it("returns 404 when approving a non-existent user", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/jest-approval-ghost-xyz/approve")
      .set("Authorization", adminBearer())
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap admin protection — ban and demote guards
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap admin protection", () => {
  it("POST /api/admin/users/:bootstrapAdminId/ban returns 400", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/ban`)
      .set("Authorization", adminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/bootstrap admin/i);
  });

  it("POST /api/admin/users/:bootstrapAdminId/demote returns 400", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/demote`)
      .set("Authorization", adminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/bootstrap admin/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ban flow: pending → banned → 403 { code: "banned" }
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/ban — ban flow", () => {
  it("returns 200 with the updated user record showing status=banned", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${TO_BAN_USER}/ban`)
      .set("Authorization", adminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.clerkUserId).toBe(TO_BAN_USER);
    expect(res.body.user.status).toBe("banned");
  });

  it("banned user receives 403 with code='banned' on any protected endpoint", async () => {
    // requireAppAuth returns 403 { code: "banned" } for banned users.
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${TO_BAN_USER}`)
      .expect(403);

    expect(res.body).toHaveProperty("code", "banned");
  });

  it("banned user appears as banned in the admin user list", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", adminBearer())
      .expect(200);

    const record = res.body.users.find(
      (u: { clerkUserId: string }) => u.clerkUserId === TO_BAN_USER,
    );
    expect(record).toBeDefined();
    expect(record.status).toBe("banned");
  });

  it("returns 404 when banning a non-existent user", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/jest-approval-ghost-xyz/ban")
      .set("Authorization", adminBearer())
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });
});
