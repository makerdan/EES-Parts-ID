/**
 * Integration tests for admin auth middleware.
 *
 * Auth model: single-role HMAC-SHA256.
 *   - Only one credential class exists: a valid admin token (timestamp + HMAC sig
 *     over ADMIN_PASSWORD).
 *   - There is no "regular user" or "authenticated non-admin" concept; no second
 *     user role is issued or accepted.
 *   - Any credential that fails HMAC verification → 401 (Unauthorized).
 *   - A structurally valid token signed with the wrong secret is therefore the
 *     closest equivalent to an "authenticated non-admin" attempt; it also returns
 *     401 — not 403 — because the server cannot distinguish it from an arbitrary
 *     forged token.
 *
 * Covers:
 * - Unauthenticated (no token) → 401 on every protected route
 * - Invalid / structurally garbage token → 401
 * - Structurally valid token signed with wrong secret (non-admin equivalent) → 401
 * - Expired token → 401
 * - Valid admin token → request proceeds (2xx / route-specific response)
 * - Zone write endpoints (POST, PATCH, DELETE) require admin auth → 401 without token
 * - Zone read endpoints (GET) are unauthenticated
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
import { signAdminToken, setRevokedBefore } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";
import { db, warehouseZoneTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-auth-middleware-secret";
let adminToken: string;

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

beforeEach(() => {
  // Reset in-memory revocation state so each test starts clean
  setRevokedBefore(0);
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
// Protected routes — invalid / structurally garbage token → 401
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
// "Non-admin equivalent" — structurally valid token, wrong secret → 401
//
// This API has a single-role auth model: there is no "regular user" credential
// that the server would issue or accept.  A token signed with a different secret
// is the closest representation of an "authenticated but non-admin" caller.
// The expected outcome is 401, not 403, because the server treats any failed
// HMAC verification as Unauthorized regardless of intent.
// ─────────────────────────────────────────────────────────────────────────────

describe("Single-role model — wrong-secret token (non-admin equivalent) → 401, not 403", () => {
  let wrongSecretToken: string;

  beforeAll(() => {
    // Produce a structurally valid token (correct format, correct timestamp)
    // but signed with a different secret — simulating a credential from a
    // principal that is "authenticated" to some other system but not to this API.
    wrongSecretToken = signAdminToken(Date.now(), "some-other-non-admin-secret");
  });

  it("POST /api/admin/upload with wrong-secret token → 401 (not 403)", async () => {
    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${wrongSecretToken}`)
      .send({ csv: "Vendor,Catalog\nACME,X001" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
    expect(res.status).not.toBe(403);
  });

  it("POST /api/inventory/upsert-batch with wrong-secret token → 401 (not 403)", async () => {
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .set("Authorization", `Bearer ${wrongSecretToken}`)
      .send({ items: [] })
      .expect(401);

    expect(res.body).toHaveProperty("error");
    expect(res.status).not.toBe(403);
  });

  it("GET /api/admin/catalog-pdf/:jobId/status with wrong-secret token → 401 (not 403)", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/1/status")
      .set("Authorization", `Bearer ${wrongSecretToken}`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
    expect(res.status).not.toBe(403);
  });

  it("PATCH /api/inventory/:id/description with wrong-secret token → 401 (not 403)", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/description")
      .set("Authorization", `Bearer ${wrongSecretToken}`)
      .send({ description: "hack" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expired token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("Expired token → 401", () => {
  it("POST /api/admin/upload with an expired token returns 401", async () => {
    // Sign with a timestamp 25 hours in the past (TTL is 24 h)
    const pastTs = Date.now() - 25 * 60 * 60 * 1000;
    const expiredToken = signAdminToken(pastTs, ADMIN_SECRET);

    const res = await supertest(app)
      .post("/api/admin/upload")
      .set("Authorization", `Bearer ${expiredToken}`)
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
// POST /admin/logout — token revocation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/logout — token revocation", () => {
  it("returns 401 without a token", async () => {
    const res = await supertest(app)
      .post("/api/admin/logout")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 with a wrong-secret token", async () => {
    const wrongToken = signAdminToken(Date.now(), "wrong-secret");
    const res = await supertest(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${wrongToken}`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 200 with a valid token and includes revokedAt", async () => {
    const token = signAdminToken(Date.now(), ADMIN_SECRET);
    const res = await supertest(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("success", true);
    expect(res.body).toHaveProperty("revokedAt");
    expect(typeof res.body.revokedAt).toBe("number");
  });

  it("token that was valid before logout returns 401 on a subsequent request", async () => {
    // Issue a token, then revoke all tokens via logout
    const token = signAdminToken(Date.now(), ADMIN_SECRET);

    // Confirm the token is valid before logout
    const preBefore = await supertest(app)
      .get("/api/admin/profile")
      .set("Authorization", `Bearer ${token}`);
    expect(preBefore.status).not.toBe(401);

    // Perform server-side logout (small sleep so revokedBefore > token ts)
    await new Promise(r => setTimeout(r, 5));
    await supertest(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Same token must now be rejected
    const postRes = await supertest(app)
      .get("/api/admin/profile")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(postRes.body).toHaveProperty("error");
  });

  it("a new token issued after logout is accepted", async () => {
    const oldToken = signAdminToken(Date.now(), ADMIN_SECRET);

    // Logout: advance the revocation fence
    await new Promise(r => setTimeout(r, 5));
    await supertest(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${oldToken}`)
      .expect(200);

    // Issue a fresh token (timestamp strictly after revokedBefore)
    await new Promise(r => setTimeout(r, 5));
    const newToken = signAdminToken(Date.now(), ADMIN_SECRET);

    const res = await supertest(app)
      .get("/api/admin/profile")
      .set("Authorization", `Bearer ${newToken}`);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("expired token is still rejected after logout even if issued after revokedBefore", async () => {
    // Sign with a timestamp 25 hours in the past
    const expiredToken = signAdminToken(Date.now() - 25 * 60 * 60 * 1000, ADMIN_SECRET);

    const res = await supertest(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zone write endpoints — require admin auth
// ─────────────────────────────────────────────────────────────────────────────

describe("Zone write endpoints require admin auth", () => {
  const AUTH_ZONE_LABEL = "JEST-ZONE-AUTH";
  const ZONE_BODY = {
    aisleId: "JEST-AUTH",
    label: AUTH_ZONE_LABEL,
    svgX: 0,
    svgY: 0,
    svgWidth: 100,
    svgHeight: 50,
  };

  async function cleanupAuthZone() {
    await db
      .delete(warehouseZoneTable)
      .where(sql`${warehouseZoneTable.label} LIKE ${"JEST-ZONE-AUTH%"}`);
  }

  beforeAll(async () => {
    await cleanupAuthZone();
  }, 15_000);

  afterAll(async () => {
    await cleanupAuthZone();
  }, 15_000);

  afterEach(async () => {
    await cleanupAuthZone();
  });

  it("POST /api/warehouse-zones without token → 401", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send(ZONE_BODY)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/warehouse-zones with wrong-secret token → 401", async () => {
    const wrongToken = signAdminToken(Date.now(), "wrong-secret");
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${wrongToken}`)
      .send(ZONE_BODY)
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("POST /api/warehouse-zones with valid token → 201", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(ZONE_BODY)
      .expect(201);

    expect(res.body).toHaveProperty("zone");
  });

  it("PATCH /api/warehouse-zones/:id without token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .send({ label: "new-label" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("DELETE /api/warehouse-zones/:id without token → 401", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("GET /api/warehouse-zones (read) requires no auth → 200", async () => {
    const res = await supertest(app).get("/api/warehouse-zones").expect(200);
    expect(res.body).toHaveProperty("zones");
  });
});
