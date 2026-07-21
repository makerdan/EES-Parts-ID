/**
 * Integration tests for the role-based auth middleware stack.
 *
 * Auth model:
 *   - `requireAppAuth` (mounted on all /api routes) requires a valid Clerk
 *     session whose user row is status='approved'. No session → 401; a
 *     pending/banned user → 403.
 *   - `requireAdminAuth` additionally requires role='admin'. An approved but
 *     non-admin user → 403.
 *   - The bootstrap admin (ADMIN_CLERK_USER_ID) is always admin + approved.
 *
 * In tests the @clerk/express mock reads `Authorization: Bearer <token>` as the
 * Clerk user id, so a "token" here is simply a Clerk user id.
 *
 * Covers:
 * - Unauthenticated (no token) → 401 on every protected route
 * - Authenticated approved non-admin → 403 on admin routes
 * - Authenticated pending user → 403
 * - Bootstrap admin → request proceeds (2xx / route-specific response)
 * - Zone write endpoints require admin; zone read requires only app auth
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
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
import { seedTestUser, cleanupTestUser } from "./helpers/testDb";

// ── Setup ─────────────────────────────────────────────────────────────────────
// The bootstrap admin authenticates simply by presenting their Clerk user id.
const adminToken = ADMIN_TEST_USER_ID;

// An approved, non-admin user (role='user').
const APPROVED_USER = "jest-auth-approved-user";
// A user awaiting approval.
const PENDING_USER = "jest-auth-pending-user";

beforeAll(async () => {
  // seedTestUser derives the email from the clerkUserId, so parallel suites
  // can never collide on users_email_unique.
  await seedTestUser({ clerkUserId: APPROVED_USER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: PENDING_USER, status: "pending", role: "user" });
});

afterAll(async () => {
  await cleanupTestUser(APPROVED_USER);
  await cleanupTestUser(PENDING_USER);
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Protected routes — no token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("Unauthenticated requests to protected routes → 401", () => {
  it("POST /api/admin/upload without token returns 401", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/inventory/upsert-batch without token returns 401", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({ items: [{ vendor: "ACME", catalog: "X001", description: "test" }] })
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/admin/catalog-pdf/:jobId/status without token returns 401", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("PATCH /api/inventory/:id/description without token returns 401", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/description")
      .send({ description: "test" })
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated but pending → 403
// ─────────────────────────────────────────────────────────────────────────────

describe("Pending user → 403 on protected routes", () => {
  it("POST /api/admin/upload with a pending user returns 403", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${PENDING_USER}`)
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authenticated approved non-admin → 403 on admin routes
// ─────────────────────────────────────────────────────────────────────────────

describe("Approved non-admin → 403 on admin routes", () => {
  it("POST /api/admin/upload with an approved non-admin returns 403 (not 401)", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(403);
    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/inventory/upsert-batch with an approved non-admin returns 403", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .send({ items: [] })
      .expect(403);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/admin/catalog-pdf/:jobId/status with an approved non-admin returns 403", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .expect(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap admin — request is accepted past auth
// ─────────────────────────────────────────────────────────────────────────────

describe("Bootstrap admin — request proceeds past auth", () => {
  it("POST /api/admin/upload with admin is accepted (not 401/403)", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "Vendor,Catalog,Description\nACME,JEST-AUTH-001,Widget" });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("POST /api/inventory/upsert-batch with admin is accepted (not 401/403)", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [] });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("GET /api/admin/catalog-pdf/:jobId/status with admin reaches the route handler", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/999999999/status")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/me — self-check (app-auth only, no admin guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/me — admin self-check", () => {
  it("returns 401 without a token", async () => {
    await supertest(app).get("/api/admin/me").expect(401);
  });

  it("returns { isAdmin: true } for the bootstrap admin", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toEqual({ isAdmin: true });
  });

  it("returns { isAdmin: false } for an approved non-admin", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .expect(200);
    expect(res.body).toEqual({ isAdmin: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Warehouse zones — write requires admin, read requires only app auth
// ─────────────────────────────────────────────────────────────────────────────

describe("Warehouse zones — write endpoints require admin", () => {
  const BODY = { aisleId: "JEST-AUTHZ", svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 };

  it("POST /api/warehouse-zones without token → 401", async () => {
    await supertest(app).post("/api/warehouse-zones").send(BODY).expect(401);
  });

  it("POST /api/warehouse-zones as approved non-admin → 403", async () => {
    await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .send(BODY)
      .expect(403);
  });

  it("POST /api/warehouse-zones as admin → not 401/403", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(BODY);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    // Cleanup any created zone.
    if (res.body?.zone?.id) {
      await supertest(app)
        .delete(`/api/warehouse-zones/${res.body.zone.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
    }
  });
});

describe("Warehouse zones — read requires only app auth", () => {
  it("GET /api/warehouse-zones without token → 401", async () => {
    await supertest(app).get("/api/warehouse-zones").expect(401);
  });

  it("GET /api/warehouse-zones as approved non-admin → 200", async () => {
    const res = await supertest(app)
      .get("/api/warehouse-zones")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .expect(200);
    expect(res.body).toHaveProperty("zones");
  });
});
