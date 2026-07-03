/**
 * Integration tests for admin user management endpoints.
 *
 * Covers:
 * - GET  /api/admin/users — auth guard (401 without token), returns user list
 * - POST /api/admin/users/:clerkUserId/approve — auth guard, approve path, 404 for unknown user
 * - POST /api/admin/users/:clerkUserId/ban    — auth guard, ban path, 404 for unknown user
 * - Authorization header is required and token must be valid for all three endpoints
 */

// ── Env vars — must be set before any require()/module imports ────────────────
process.env.ADMIN_PASSWORD = "jest-admin-users-secret";

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
import { signAdminToken } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";
import { db, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-admin-users-secret";
const FIXTURE_PREFIX = "jest-itg-user-";

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeAdminToken(): string {
  return signAdminToken(Date.now(), ADMIN_SECRET);
}

function makeWrongToken(): string {
  return signAdminToken(Date.now(), "wrong-secret");
}

async function seedUser(
  clerkUserId: string,
  email: string,
  status: "pending" | "approved" | "banned" = "pending",
) {
  await db
    .insert(usersTable)
    .values({ clerkUserId, email, status })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { email, status },
    });
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

afterAll(async () => {
  await closePool();
}, 15_000);

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

  it("returns 401 when a garbage token is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", "Bearer not-a-real-token")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when the token is signed with the wrong secret", async () => {
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${makeWrongToken()}`)
      .expect(401);

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
    await seedUser(`${FIXTURE_PREFIX}alice`, "alice@example.com", "pending");
    await seedUser(`${FIXTURE_PREFIX}bob`, "bob@example.com", "approved");

    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const users: Array<Record<string, unknown>> = res.body.users;
    const alice = users.find(u => u.clerkUserId === `${FIXTURE_PREFIX}alice`);
    const bob = users.find(u => u.clerkUserId === `${FIXTURE_PREFIX}bob`);

    expect(alice).toBeDefined();
    expect(alice?.email).toBe("alice@example.com");
    expect(alice?.status).toBe("pending");
    expect(alice).toHaveProperty("createdAt");
    expect(alice).toHaveProperty("updatedAt");

    expect(bob).toBeDefined();
    expect(bob?.email).toBe("bob@example.com");
    expect(bob?.status).toBe("approved");
  });

  it("includes users with all three status values", async () => {
    await seedUser(`${FIXTURE_PREFIX}pending-1`, "p@example.com", "pending");
    await seedUser(`${FIXTURE_PREFIX}approved-1`, "a@example.com", "approved");
    await seedUser(`${FIXTURE_PREFIX}banned-1`, "b@example.com", "banned");

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

  it("returns 401 when a garbage token is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/approve")
      .set("Authorization", "Bearer garbage-token")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when the token is signed with the wrong secret", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/approve")
      .set("Authorization", `Bearer ${makeWrongToken()}`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/approve — authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/approve — authenticated", () => {
  it("sets a pending user's status to approved and returns the updated user", async () => {
    const userId = `${FIXTURE_PREFIX}approve-me`;
    await seedUser(userId, "approve@example.com", "pending");

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
    await seedUser(userId, "persist@example.com", "pending");

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
    await seedUser(userId, "banned@example.com", "banned");

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

  it("returns 401 when a garbage token is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/ban")
      .set("Authorization", "Bearer garbage-token")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 when the token is signed with the wrong secret", async () => {
    const res = await supertest(app)
      .post("/api/admin/users/some-user-id/ban")
      .set("Authorization", `Bearer ${makeWrongToken()}`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:clerkUserId/ban — authenticated
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:clerkUserId/ban — authenticated", () => {
  it("sets a pending user's status to banned and returns the updated user", async () => {
    const userId = `${FIXTURE_PREFIX}ban-me`;
    await seedUser(userId, "ban@example.com", "pending");

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
    await seedUser(userId, "persistban@example.com", "pending");

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
    await seedUser(userId, "approved@example.com", "approved");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.user.status).toBe("banned");
  });
});
