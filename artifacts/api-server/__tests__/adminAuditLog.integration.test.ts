/**
 * Integration tests for the admin action audit log.
 *
 * Covers:
 * - Each action type (approve/ban/promote/demote) writes one audit row.
 * - GET /api/admin/audit-log is blocked for non-admins (403) and unauthenticated (401).
 * - Failed actions (404 target user) produce no audit row.
 * - The audit log endpoint returns rows in reverse-chronological order.
 */

// ── http-proxy-middleware is ESM-only — mock before app is imported ────────
jest.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: jest.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

// ── OpenAI constructor mock ────────────────────────────────────────────────
class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation(() => ({
    chat: { completions: { create: jest.fn().mockResolvedValue({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: "hi" } }],
    }) } },
  }));

(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError = MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError = MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError = MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError = MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError = MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError = MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

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

// ── Imports ────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { type AdminAuditAction, adminAuditLogTable, db, usersTable } from "@workspace/db";
import { and, eq, gte, like } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────
const FIXTURE_PREFIX = "jest-audit-";

// ── Helpers ────────────────────────────────────────────────────────────────
function makeAdminToken(): string {
  return ADMIN_TEST_USER_ID;
}

async function seedUser(
  clerkUserId: string,
  email: string,
  status: "pending" | "approved" | "banned" = "pending",
  role: "user" | "admin" = "user",
) {
  await db
    .insert(usersTable)
    .values({ clerkUserId, email, status, role })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { email, status, role },
    });
}

async function seedNonAdmin(): Promise<string> {
  const id = `${FIXTURE_PREFIX}nonadmin`;
  await seedUser(id, "audit-nonadmin@example.com", "approved", "user");
  return id;
}

async function countAuditRows(
  targetClerkUserId: string,
  action: AdminAuditAction,
  since: Date,
): Promise<number> {
  const rows = await db
    .select()
    .from(adminAuditLogTable)
    .where(
      and(
        eq(adminAuditLogTable.targetClerkUserId, targetClerkUserId),
        eq(adminAuditLogTable.action, action),
        gte(adminAuditLogTable.createdAt, since),
      ),
    );
  return rows.length;
}

async function cleanupUsers() {
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${FIXTURE_PREFIX}%`));
}

async function cleanupAuditRows() {
  await db
    .delete(adminAuditLogTable)
    .where(like(adminAuditLogTable.targetClerkUserId, `${FIXTURE_PREFIX}%`));
}

// ── Setup / teardown ───────────────────────────────────────────────────────
afterEach(async () => {
  await cleanupUsers();
  await cleanupAuditRows();
});


// ── Audit row creation per action ──────────────────────────────────────────

describe("approve action — audit row", () => {
  it("writes one audit row when a user is successfully approved", async () => {
    const userId = `${FIXTURE_PREFIX}approve`;
    await seedUser(userId, "audit-approve@example.com", "pending");
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    // Allow fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "approve", since);
    expect(count).toBe(1);
  });

  it("does NOT write an audit row when the target user does not exist (404)", async () => {
    const userId = `${FIXTURE_PREFIX}approve-missing`;
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "approve", since);
    expect(count).toBe(0);
  });
});

describe("ban action — audit row", () => {
  it("writes one audit row when a user is successfully banned", async () => {
    const userId = `${FIXTURE_PREFIX}ban`;
    await seedUser(userId, "audit-ban@example.com", "pending");
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "ban", since);
    expect(count).toBe(1);
  });

  it("does NOT write an audit row when the target user does not exist (404)", async () => {
    const userId = `${FIXTURE_PREFIX}ban-missing`;
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/ban`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "ban", since);
    expect(count).toBe(0);
  });
});

describe("promote action — audit row", () => {
  it("writes one audit row when a user is successfully promoted", async () => {
    const userId = `${FIXTURE_PREFIX}promote`;
    await seedUser(userId, "audit-promote@example.com", "approved", "user");
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "promote", since);
    expect(count).toBe(1);
  });

  it("does NOT write an audit row when the target user does not exist (404)", async () => {
    const userId = `${FIXTURE_PREFIX}promote-missing`;
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/promote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "promote", since);
    expect(count).toBe(0);
  });
});

describe("demote action — audit row", () => {
  it("writes one audit row when a user is successfully demoted", async () => {
    const userId = `${FIXTURE_PREFIX}demote`;
    await seedUser(userId, "audit-demote@example.com", "approved", "admin");
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "demote", since);
    expect(count).toBe(1);
  });

  it("does NOT write an audit row when the target user does not exist (404)", async () => {
    const userId = `${FIXTURE_PREFIX}demote-missing`;
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(404);

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(userId, "demote", since);
    expect(count).toBe(0);
  });
});

// ── Self-action blocks — no audit rows ────────────────────────────────────

describe("self-action blocks — no audit row produced", () => {
  it("approve: self-action returns 400 and writes no audit row", async () => {
    const since = new Date();

    // The bootstrap admin attempting to approve themselves
    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(ADMIN_TEST_USER_ID, "approve", since);
    expect(count).toBe(0);
  });

  it("ban: self-action returns 400 and writes no audit row", async () => {
    const since = new Date();

    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/ban`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(ADMIN_TEST_USER_ID, "ban", since);
    expect(count).toBe(0);
  });

  it("demote: self-action returns 400 and writes no audit row", async () => {
    const since = new Date();

    const res = await supertest(app)
      .post(`/api/admin/users/${ADMIN_TEST_USER_ID}/demote`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");

    await new Promise((r) => setTimeout(r, 200));

    const count = await countAuditRows(ADMIN_TEST_USER_ID, "demote", since);
    expect(count).toBe(0);
  });
});

// ── GET /api/admin/audit-log — auth guard ─────────────────────────────────

describe("GET /api/admin/audit-log — auth guard", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/audit-log")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const nonAdmin = await seedNonAdmin();
    const res = await supertest(app)
      .get("/api/admin/audit-log")
      .set("Authorization", `Bearer ${nonAdmin}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ── GET /api/admin/audit-log — authenticated ───────────────────────────────

describe("GET /api/admin/audit-log — authenticated", () => {
  it("returns 200 with a paginated rows array", async () => {
    const res = await supertest(app)
      .get("/api/admin/audit-log")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body).toHaveProperty("nextCursor");
  });

  it("includes rows written by approve/ban/promote/demote with expected shape", async () => {
    const userId = `${FIXTURE_PREFIX}shape`;
    await seedUser(userId, "audit-shape@example.com", "pending");
    const since = new Date();

    await supertest(app)
      .post(`/api/admin/users/${userId}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    await new Promise((r) => setTimeout(r, 200));

    const res = await supertest(app)
      .get("/api/admin/audit-log?limit=200")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const rows: Array<Record<string, unknown>> = res.body.rows;
    const row = rows.find(
      (r) => r.targetClerkUserId === userId && r.action === "approve" &&
             new Date(r.createdAt as string) >= since,
    );

    expect(row).toBeDefined();
    expect(row).toHaveProperty("id");
    expect(row).toHaveProperty("adminClerkUserId");
    expect(row).toHaveProperty("targetClerkUserId", userId);
    expect(row).toHaveProperty("action", "approve");
    expect(row).toHaveProperty("createdAt");
  });

  it("returns rows in reverse-chronological order", async () => {
    const userA = `${FIXTURE_PREFIX}order-a`;
    const userB = `${FIXTURE_PREFIX}order-b`;
    await seedUser(userA, "audit-order-a@example.com", "pending");
    await seedUser(userB, "audit-order-b@example.com", "pending");

    await supertest(app)
      .post(`/api/admin/users/${userA}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    // Small delay to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 50));

    await supertest(app)
      .post(`/api/admin/users/${userB}/approve`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    await new Promise((r) => setTimeout(r, 200));

    const res = await supertest(app)
      .get("/api/admin/audit-log?limit=200")
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .expect(200);

    const rows: Array<Record<string, unknown>> = res.body.rows;
    const filtered = rows.filter(
      (r) => r.targetClerkUserId === userA || r.targetClerkUserId === userB,
    );
    expect(filtered.length).toBeGreaterThanOrEqual(2);

    const dates = filtered.map((r) => new Date(r.createdAt as string).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]!).toBeGreaterThanOrEqual(dates[i]!);
    }
  });
});
