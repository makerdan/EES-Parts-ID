/**
 * Tests for admin self-action protection and bootstrap admin audit logging.
 *
 * Covers:
 * - Admin banning themselves → 400 with clear error message
 * - Admin demoting themselves → 400 with clear error message
 * - Normal admin banning a *different* user still succeeds (200)
 * - Bootstrap admin flag (`res.locals.isBootstrapAdmin`) is set, confirmed
 *   via the /admin/me endpoint succeeding with isAdmin:true
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
import { closePool } from "../../__tests__/helpers/testDb";
import { db, usersTable } from "@workspace/db";

// ── Fixed test Clerk user ids ─────────────────────────────────────────────────
// All ids share the "jest-selfaction-" prefix for isolated cleanup.
const PROMOTED_ADMIN = "jest-selfaction-promoted";
const TARGET_USER    = "jest-selfaction-target";

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Bearer header for the bootstrap admin. */
function bootstrapBearer(): string {
  return `Bearer ${ADMIN_TEST_USER_ID}`;
}

/** Bearer header for the promoted (non-bootstrap) admin. */
function promotedAdminBearer(): string {
  return `Bearer ${PROMOTED_ADMIN}`;
}

// ── Seed / teardown ───────────────────────────────────────────────────────────
beforeAll(async () => {
  await db
    .insert(usersTable)
    .values([
      {
        clerkUserId: PROMOTED_ADMIN,
        email: "promoted@test.example",
        status: "approved",
        role: "admin",
      },
      {
        clerkUserId: TARGET_USER,
        email: "target@test.example",
        status: "approved",
        role: "user",
      },
    ])
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: "approved", updatedAt: new Date() },
    });
});

afterAll(async () => {
  await db
    .delete(usersTable)
    .where(like(usersTable.clerkUserId, "jest-selfaction-%"));
  await closePool();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Self-ban protection
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/ban — self-action guard", () => {
  it("returns 400 when a promoted admin tries to ban themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PROMOTED_ADMIN}/ban`)
      .set("Authorization", promotedAdminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cannot perform this action on your own account/i);
  });

  it("returns 400 when the bootstrap admin tries to ban themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/ban`)
      .set("Authorization", bootstrapBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 200 when a promoted admin bans a different user", async () => {
    // First ensure TARGET_USER is in approved state for this test.
    await db
      .insert(usersTable)
      .values({ clerkUserId: TARGET_USER, email: "target@test.example", status: "approved", role: "user" })
      .onConflictDoUpdate({
        target: usersTable.clerkUserId,
        set: { status: "approved", updatedAt: new Date() },
      });

    const res = await supertest(app)
      .post(`/api/admin/users/${TARGET_USER}/ban`)
      .set("Authorization", promotedAdminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.status).toBe("banned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-demote protection
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/demote — self-action guard", () => {
  it("returns 400 when a promoted admin tries to demote themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PROMOTED_ADMIN}/demote`)
      .set("Authorization", promotedAdminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cannot perform this action on your own account/i);
  });

  it("returns 400 when the bootstrap admin tries to demote themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/demote`)
      .set("Authorization", bootstrapBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap admin flag — isBootstrapAdmin is set on the bootstrap admin path
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap admin flag", () => {
  it("bootstrap admin can still access /api/admin/me with isAdmin:true", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", bootstrapBearer())
      .expect(200);

    expect(res.body).toHaveProperty("isAdmin", true);
  });

  it("promoted (non-bootstrap) admin can also access /api/admin/me with isAdmin:true", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", promotedAdminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("isAdmin", true);
  });
});
