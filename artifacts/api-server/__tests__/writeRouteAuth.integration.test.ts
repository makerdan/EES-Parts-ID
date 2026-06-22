/**
 * Regression guard: every write route that added requireAdminAuth middleware
 * must reject unauthenticated and invalid-token requests forever.
 *
 * Covered endpoints:
 *   POST   /api/warehouse-zones
 *   PATCH  /api/warehouse-zones/:id
 *   DELETE /api/warehouse-zones/:id
 *   POST   /api/reference/quick-lookups/:label
 *   PATCH  /api/inventory/:id/keywords
 *
 * For each route we assert:
 *   1. No token          → 401
 *   2. Garbage token     → 401
 *   3. Structurally valid token signed with the wrong secret → 401
 *
 * Additional:
 *   4. When ADMIN_PASSWORD is unset, POST /reference/quick-lookups/:label → 503
 *
 * None of these tests exercise successful writes — they stop at the auth
 * layer, so no database fixtures are needed.
 */

// ── Mock OpenAI before app is imported ────────────────────────────────────────
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
import { signAdminToken, setRevokedBefore } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";

// ── Global setup ──────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-write-auth-secret";

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
});

beforeEach(() => {
  setRevokedBefore(0);
});

afterAll(async () => {
  await closePool();
}, 15_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function validToken(): string {
  return signAdminToken(Date.now(), ADMIN_SECRET);
}

function wrongSecretToken(): string {
  return signAdminToken(Date.now(), "not-the-real-secret");
}

const GARBAGE_TOKEN = "this.is.not.a.real.token";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/warehouse-zones
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/warehouse-zones — auth guard", () => {
  const BODY = { aisleId: "JEST-W", svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 };

  it("no token → 401", async () => {
    const res = await supertest(app).post("/api/warehouse-zones").send(BODY).expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("garbage token → 401", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${GARBAGE_TOKEN}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("wrong-secret token → 401", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${wrongSecretToken()}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("valid token → request passes auth (not 401)", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .set("Authorization", `Bearer ${validToken()}`)
      .send(BODY);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/warehouse-zones/:id — auth guard", () => {
  const BODY = { svgX: 5 };

  it("no token → 401", async () => {
    const res = await supertest(app).patch("/api/warehouse-zones/1").send(BODY).expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("garbage token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${GARBAGE_TOKEN}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("wrong-secret token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${wrongSecretToken()}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("valid token → request passes auth (not 401/403)", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${validToken()}`)
      .send(BODY);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/warehouse-zones/:id — auth guard", () => {
  it("no token → 401", async () => {
    const res = await supertest(app).delete("/api/warehouse-zones/1").expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("garbage token → 401", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${GARBAGE_TOKEN}`)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("wrong-secret token → 401", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${wrongSecretToken()}`)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("valid token → request passes auth (not 401/403)", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/1")
      .set("Authorization", `Bearer ${validToken()}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reference/quick-lookups/:label
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/reference/quick-lookups/:label — auth guard", () => {
  const BODY = { question: "What is the part number?" };

  it("no token → 401", async () => {
    const res = await supertest(app)
      .post("/api/reference/quick-lookups/test-label")
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("garbage token → 401", async () => {
    const res = await supertest(app)
      .post("/api/reference/quick-lookups/test-label")
      .set("Authorization", `Bearer ${GARBAGE_TOKEN}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("wrong-secret token → 401", async () => {
    const res = await supertest(app)
      .post("/api/reference/quick-lookups/test-label")
      .set("Authorization", `Bearer ${wrongSecretToken()}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/reference/quick-lookups/:label — ADMIN_PASSWORD unset → 503", () => {
  it("returns 503 when ADMIN_PASSWORD env var is not set", async () => {
    const originalPassword = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;

    const res = await supertest(app)
      .post("/api/reference/quick-lookups/test-label")
      .send({ question: "What is the part number?" });

    process.env.ADMIN_PASSWORD = originalPassword;

    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/keywords
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/keywords — auth guard", () => {
  const BODY = { keywords: ["motor", "bearing"] };

  it("no token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/keywords")
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("garbage token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/keywords")
      .set("Authorization", `Bearer ${GARBAGE_TOKEN}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("wrong-secret token → 401", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/keywords")
      .set("Authorization", `Bearer ${wrongSecretToken()}`)
      .send(BODY)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("valid token → request passes auth (not 401/403)", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/1/keywords")
      .set("Authorization", `Bearer ${validToken()}`)
      .send(BODY);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
