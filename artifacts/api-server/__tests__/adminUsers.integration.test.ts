/**
 * Integration tests for admin user management endpoints.
 *
 * Auth model (see auth.integration.test.ts): endpoints require a valid Clerk
 * session (requireAppAuth) plus role='admin' (requireAdminAuth). No session →
 * 401; approved non-admin → 403. The @clerk/express mock reads
 * `Authorization: Bearer <token>` as the Clerk user id.
 *
 * Covers:
 * - GET  /api/admin/users — auth guard, returns user list (incl. role field)
 * - POST /api/admin/users/:clerkUserId/approve — auth guard, approve path, 404
 * - POST /api/admin/users/:clerkUserId/ban    — auth guard, ban path, 404
 * - POST /api/admin/users/:clerkUserId/promote — role→admin, 400 unless approved
 * - POST /api/admin/users/:clerkUserId/demote  — role→user, 400 for bootstrap admin
 */

// ── http-proxy-middleware is ESM-only — mock it before app is imported ────────
jest.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: jest.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

// ── OpenAI constructor mock (loaded transitively by ai routes at module init) ─
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
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { db, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────────
const FIXTURE_PREFIX = "jest-itg-user-";

// ── Helpers ───────────────────────────────────────────────────────────────────
// The bootstrap admin authenticates by presenting their Clerk user id.
function makeAdminToken(): string {
  return ADMIN_TEST_USER_ID;
}

// Collision-safe under parallel Jest workers: the email is DERIVED from the
// clerkUserId (same convention as helpers/testDb.ts seedTestUser), so this
// suite can never trip the users_email_unique constraint against another
// suite's hand-written email.
function emailFor(clerkUserId: string): string {
  return `${clerkUserId.toLowerCase()}@jest.test.example`;
}

async function seedUser(
  clerkUserId: string,
  status: "pending" | "approved" | "banned" = "pending",
  role: "user" | "admin" = "user",
) {
  const email = emailFor(clerkUserId);
  await db
    .insert(usersTable)
    .values({ clerkUserId, email, status, role })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { email, status, role },
    });
}

/** Seeds an approved, non-admin user and returns its Clerk user id (= token). */
async function seedNonAdmin(): Promise<string> {
  const id = `${FIXTURE_PREFIX}nonadmin`;
  await seedUser(id, "approved", "user");
  return id;
}

async function cleanupUsers() {
  await db
    .delete(usersTable)
    .where(like(usersTable.clerkUserId, `${FIXTURE_PREFIX}%`));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
afterEach(async () => {
  await cleanupUsers();
});


// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — GET /api/admin/users
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users — authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — authenticated", () => {
  it("returns 200 with a { users: [] } shape when no users exist", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("users");
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  it("returns seeded users with clerkUserId, email, status, createdAt, updatedAt fields", async () => {
    await seedUser(`${FIXTURE_PREFIX}alice`, "pending");
    await seedUser(`${FIXTURE_PREFIX}bob`, "approved");

    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const alice = users.find(u => u.clerkUserId === `${FIXTURE_PREFIX}alice`);
    const bob = users.find(u => u.clerkUserId === `${FIXTURE_PREFIX}bob`);

    expect(alice).toBeDefined();
    expect(alice?.email).toBe(emailFor(`${FIXTURE_PREFIX}alice`));
    expect(alice?.status).toBe("pending");
    expect(alice).toHaveProperty("createdAt");
    expect(alice).toHaveProperty("updatedAt");

    expect(bob).toBeDefined();
    expect(bob?.email).toBe(emailFor(`${FIXTURE_PREFIX}bob`));
    expect(bob?.status).toBe("approved");
  });

  it("includes users with all three status values", async () => {
    await seedUser(`${FIXTURE_PREFIX}pending-1`, "pending");
    await seedUser(`${FIXTURE_PREFIX}approved-1`, "approved");
    await seedUser(`${FIXTURE_PREFIX}banned-1`, "banned");

    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const statuses = users
      .filter(u => String(u.clerkUserId).startsWith(FIXTURE_PREFIX))
      .map(u => u.status);

    expect(statuses).toContain("pending");
    expect(statuses).toContain("approved");
    expect(statuses).toContain("banned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — POST /api/admin/users/:id/approve
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/approve — auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/approve")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/approve")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/approve — authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/approve — authenticated", () => {
  it("sets a pending user's status to approved and returns the updated user", async () => {
    const userId = `${FIXTURE_PREFIX}approve-me`;
    await seedUser(userId, "pending");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.clerkUserId).toBe(userId);
    expect(res.body.user.status).toBe("approved");
  });

  it("persists the approved status to the database", async () => {
    const userId = `${FIXTURE_PREFIX}persist-approve`;
    await seedUser(userId, "pending");

    const token = makeAdminToken();
    await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("approved");
  });

  it("returns 404 when the clerkUserId does not exist", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/users/nonexistent-clerk-id-xyz/approve")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("can also approve an already-banned user", async () => {
    const userId = `${FIXTURE_PREFIX}was-banned`;
    await seedUser(userId, "banned");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.user.status).toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — POST /api/admin/users/:id/ban
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/ban — auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/ban")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/ban")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/ban — authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/ban — authenticated", () => {
  it("sets a pending user's status to banned and returns the updated user", async () => {
    const userId = `${FIXTURE_PREFIX}ban-me`;
    await seedUser(userId, "pending");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.clerkUserId).toBe(userId);
    expect(res.body.user.status).toBe("banned");
  });

  it("persists the banned status to the database", async () => {
    const userId = `${FIXTURE_PREFIX}persist-ban`;
    await seedUser(userId, "pending");

    const token = makeAdminToken();
    await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("banned");
  });

  it("returns 404 when the clerkUserId does not exist", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/users/nonexistent-clerk-id-xyz/ban")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("can also ban an already-approved user", async () => {
    const userId = `${FIXTURE_PREFIX}was-approved`;
    await seedUser(userId, "approved");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.user.status).toBe("banned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/promote
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/promote", () => {
  it("returns 401 without a token", async () => {
    await supertest(app)
      .post("/api/admin/users/some-user-id/promote")
      .expect(401);
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    await supertest(app)
      .post("/api/admin/users/some-user-id/promote")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);
  });

  it("promotes an approved user to admin", async () => {
    const userId = `${FIXTURE_PREFIX}promote-me`;
    await seedUser(userId, "approved", "user");

    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    expect(res.body.user.role).toBe("admin");

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));
    expect(rows[0]?.role).toBe("admin");
  });

  it("returns 400 when promoting a user who is not approved", async () => {
    const userId = `${FIXTURE_PREFIX}promote-pending`;
    await seedUser(userId, "pending", "user");

    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the clerkUserId does not exist", async () => {
    await supertest(app)
      .post("/api/admin/users/nonexistent-promote-xyz/promote")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/demote
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/demote", () => {
  it("returns 401 without a token", async () => {
    await supertest(app)
      .post("/api/admin/users/some-user-id/demote")
      .expect(401);
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    await supertest(app)
      .post("/api/admin/users/some-user-id/demote")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);
  });

  it("demotes an admin user back to role=user", async () => {
    const userId = `${FIXTURE_PREFIX}demote-me`;
    await seedUser(userId, "approved", "admin");

    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    expect(res.body.user.role).toBe("user");

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));
    expect(rows[0]?.role).toBe("user");
  });

  it("returns 400 when attempting to demote the bootstrap admin", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the clerkUserId does not exist", async () => {
    await supertest(app)
      .post("/api/admin/users/nonexistent-demote-xyz/demote")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users — role field
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/users — role field", () => {
  it("includes a role field for each user", async () => {
    await seedUser(`${FIXTURE_PREFIX}role-user`, "approved", "user");
    await seedUser(`${FIXTURE_PREFIX}role-admin`, "approved", "admin");

    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const u = users.find(x => x.clerkUserId === `${FIXTURE_PREFIX}role-user`);
    const a = users.find(x => x.clerkUserId === `${FIXTURE_PREFIX}role-admin`);

    expect(u).toHaveProperty("role", "user");
    expect(a).toHaveProperty("role", "admin");
  });

  it("reflects a promoted user's role immediately in the user list", async () => {
    const userId = `${FIXTURE_PREFIX}role-after-promote`;
    await seedUser(userId, "approved", "user");

    await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const found = users.find(u => u.clerkUserId === userId);
    expect(found).toHaveProperty("role", "admin");
  });

  it("reflects a demoted user's role immediately in the user list", async () => {
    const userId = `${FIXTURE_PREFIX}role-after-demote`;
    await seedUser(userId, "approved", "admin");

    await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const found = users.find(u => u.clerkUserId === userId);
    expect(found).toHaveProperty("role", "user");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/me — self-check (app-auth only)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/me", () => {
  it("returns 401 without a token", async () => {
    await supertest(app).get("/api/admin/me").expect(401);
  });

  it("returns { isAdmin: true } for the bootstrap admin", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    expect(res.body).toEqual({ isAdmin: true });
  });

  it("returns { isAdmin: false } for an approved non-admin", async () => {
    const nonAdmin = await seedNonAdmin();
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(200);

    expect(res.body).toEqual({ isAdmin: false });
  });

  it("returns { isAdmin: true } for a user after they are promoted", async () => {
    const userId = `${FIXTURE_PREFIX}promote-then-me`;
    await seedUser(userId, "approved", "user");

    await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(200);

    expect(res.body).toEqual({ isAdmin: true });
  });

  it("returns { isAdmin: false } for a user after they are demoted", async () => {
    const userId = `${FIXTURE_PREFIX}demote-then-me`;
    await seedUser(userId, "approved", "admin");

    await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(200);

    expect(res.body).toEqual({ isAdmin: false });
  });

  it("full round-trip: promote → isAdmin true → demote → isAdmin false", async () => {
    const userId = `${FIXTURE_PREFIX}roundtrip`;
    await seedUser(userId, "approved", "user");

    await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const afterPromote = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(200);
    expect(afterPromote.body).toEqual({ isAdmin: true });

    await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const afterDemote = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(200);
    expect(afterDemote.body).toEqual({ isAdmin: false });
  });
});
