/**
 * Integration tests for admin auth middleware.
 *
 * Covers:
 * - Unauthenticated (no token) → 401 on every protected route
 * - Invalid token → 401
 * - Valid admin token → request proceeds (2xx / route-specific response)
 * - devOnly (warehouse zone write) endpoints → 403 in production mode
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
import { signAdminToken } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-auth-middleware-secret";
let adminToken: string;

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

afterAll(async () => {
  await closePool();
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

  it("GET /api/admin/catalog-pdf/reviews without token returns 401", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/reviews")
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
// Protected routes — invalid token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("Invalid token requests to protected routes → 401", () => {
  it("POST /api/admin/upload with bad token returns 401", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", "Bearer this-is-not-a-valid-token")
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/inventory/upsert-batch with bad token returns 401", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", "Bearer garbage-token")
      .send({ items: [{ vendor: "ACME", catalog: "X001", description: "test" }] })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/admin/catalog-pdf/:jobId/status with bad token returns 401", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .set("Authorization", "Bearer garbage")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("malformed Authorization header (no Bearer prefix) returns 401", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", adminToken)
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Valid admin token — request is accepted
// ─────────────────────────────────────────────────────────────────────────────

describe("Valid admin token — request proceeds past auth", () => {
  it("POST /api/admin/upload with valid token is accepted (≥ 200, not 401)", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ csv: "Vendor,Catalog,Description\nACME,JEST-AUTH-001,Widget" });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("POST /api/inventory/upsert-batch with valid token is accepted (≥ 200, not 401)", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ items: [] });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("GET /api/admin/catalog-pdf/:jobId/status with valid token reaches the route handler", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/999999999/status")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// devOnly (warehouse zone writes) — 403 in production mode
// ─────────────────────────────────────────────────────────────────────────────

describe("devOnly warehouse-zone writes → 403 in production mode", () => {
  afterEach(() => {
    process.env.NODE_ENV = "test";
  });

  it("POST /api/warehouse-zones returns 403 in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send({
        aisleId: "A1",
        label: "JEST-AUTH-ZONE",
        svgX: 0,
        svgY: 0,
        svgWidth: 100,
        svgHeight: 50,
      })
      .expect(403);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/disabled in production/i);
  });

  it("PATCH /api/warehouse-zones/:id returns 403 in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .send({ label: "new-label" })
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });

  it("DELETE /api/warehouse-zones/:id returns 403 in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/warehouse-zones (read) is allowed in production", async () => {
    process.env.NODE_ENV = "production";
    const res = await supertest(app).get("/api/warehouse-zones").expect(200);
    expect(res.body).toHaveProperty("zones");
  });
});
