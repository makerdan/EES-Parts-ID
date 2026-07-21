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

import app from "../app";
import { ADMIN_TEST_USER_ID } from "../../__tests__/helpers/adminAuth";
import { seedTestUser, cleanupTestUser } from "../../__tests__/helpers/testDb";

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
  // seedTestUser derives each email from the clerkUserId (collision-safe).
  await seedTestUser({ clerkUserId: PROMOTED_ADMIN, status: "approved", role: "admin" });
  await seedTestUser({ clerkUserId: TARGET_USER, status: "approved", role: "user" });
});

afterAll(async () => {
  await cleanupTestUser(PROMOTED_ADMIN);
  await cleanupTestUser(TARGET_USER);
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
    await seedTestUser({ clerkUserId: TARGET_USER, status: "approved", role: "user" });

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
// Self-approve protection
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/users/:id/approve — self-action guard", () => {
  it("returns 400 when a promoted admin tries to approve themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${PROMOTED_ADMIN}/approve`)
      .set("Authorization", promotedAdminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cannot perform this action on your own account/i);
  });

  it("returns 400 when the bootstrap admin tries to approve themselves", async () => {
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/approve`)
      .set("Authorization", bootstrapBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cannot perform this action on your own account/i);
  });

  it("returns 200 when a promoted admin approves a different user", async () => {
    await seedTestUser({ clerkUserId: TARGET_USER, status: "pending", role: "user" });

    const res = await supertest(app)
      .post(`/api/admin/users/${TARGET_USER}/approve`)
      .set("Authorization", promotedAdminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("user");
    expect(res.body.user.status).toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /admin/users/:id — self-delete guard and bootstrap-admin guard
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/admin/users/:id — delete guards", () => {
  // A dedicated user that each success-path test can safely delete.
  const DELETABLE_USER = "jest-selfaction-deletable";

  beforeEach(async () => {
    // Re-seed before every test so the success case always finds a row.
    await seedTestUser({ clerkUserId: DELETABLE_USER, status: "approved", role: "user" });
  });

  afterEach(async () => {
    // Clean up the deletable user in case a test did NOT delete it.
    await cleanupTestUser(DELETABLE_USER);
  });

  it("returns 400 when a promoted admin tries to delete themselves", async () => {
    const res = await supertest(app)
      .delete(`/api/admin/users/${PROMOTED_ADMIN}`)
      .set("Authorization", promotedAdminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/cannot delete your own account/i);
  });

  it("returns 400 when the bootstrap admin tries to delete themselves", async () => {
    const res = await supertest(app)
      .delete(`/api/admin/users/${ADMIN_TEST_USER_ID}`)
      .set("Authorization", bootstrapBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    // bootstrap admin hits the ADMIN_CLERK_USER_ID guard first
    expect(res.body.error).toMatch(/bootstrap admin cannot be deleted/i);
  });

  it("returns 400 when any admin targets the bootstrap admin", async () => {
    const res = await supertest(app)
      .delete(`/api/admin/users/${ADMIN_TEST_USER_ID}`)
      .set("Authorization", promotedAdminBearer())
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/bootstrap admin cannot be deleted/i);
  });

  it("returns 404 when the target user does not exist", async () => {
    const res = await supertest(app)
      .delete("/api/admin/users/jest-selfaction-nonexistent")
      .set("Authorization", promotedAdminBearer())
      .expect(404);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/user not found/i);
  });

  it("returns 200 with deleted:true when a promoted admin deletes another user", async () => {
    const res = await supertest(app)
      .delete(`/api/admin/users/${DELETABLE_USER}`)
      .set("Authorization", promotedAdminBearer())
      .expect(200);

    expect(res.body).toEqual({ deleted: true, clerkDeleted: true });
  });

  it("returns 200 with deleted:true when the bootstrap admin deletes another user", async () => {
    const res = await supertest(app)
      .delete(`/api/admin/users/${DELETABLE_USER}`)
      .set("Authorization", bootstrapBearer())
      .expect(200);

    expect(res.body).toEqual({ deleted: true, clerkDeleted: true });
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
