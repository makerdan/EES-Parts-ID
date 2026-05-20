/**
 * Integration tests for GET/POST/PATCH/DELETE /api/warehouse-zones.
 *
 * Mutation endpoints are dev-only (blocked in production via devOnly middleware).
 * No admin auth is required for mutations in dev mode.
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
import { closePool } from "./helpers/testDb";
import { db, warehouseZoneTable } from "@workspace/db";
import { sql } from "drizzle-orm";

// ── Cleanup helpers ───────────────────────────────────────────────────────────
const ZONE_LABEL_PREFIX = "JEST-ZONE-";

async function cleanupZones() {
  await db
    .delete(warehouseZoneTable)
    .where(sql`${warehouseZoneTable.label} LIKE ${"JEST-ZONE-%"}`);
}

const BASE_ZONE = {
  aisleId: "A1",
  label: `${ZONE_LABEL_PREFIX}001`,
  svgX: 10,
  svgY: 20,
  svgWidth: 100,
  svgHeight: 50,
};

beforeAll(async () => {
  await cleanupZones();
}, 15_000);

afterAll(async () => {
  await cleanupZones();
  await closePool();
}, 15_000);

afterEach(async () => {
  await cleanupZones();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/warehouse-zones
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/warehouse-zones", () => {
  it("returns 200 and a zones array", async () => {
    const res = await supertest(app).get("/api/warehouse-zones").expect(200);
    expect(res.body).toHaveProperty("zones");
    expect(Array.isArray(res.body.zones)).toBe(true);
  });

  it("reflects a newly created zone in the list", async () => {
    await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const res = await supertest(app).get("/api/warehouse-zones").expect(200);
    const found = res.body.zones.find(
      (z: { label: string }) => z.label === BASE_ZONE.label,
    );
    expect(found).toBeDefined();
    expect(found.aisleId).toBe("A1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/warehouse-zones
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/warehouse-zones", () => {
  it("creates a zone and returns 201 with the zone object", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    expect(res.body).toHaveProperty("zone");
    expect(res.body.zone.label).toBe(BASE_ZONE.label);
    expect(res.body.zone.aisleId).toBe("A1");
    expect(typeof res.body.zone.id).toBe("number");
  });

  it("defaults sectionParity to 'all' when omitted", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    expect(res.body.zone.sectionParity).toBe("all");
  });

  it("accepts explicit sectionParity values: odd, even, all", async () => {
    for (const parity of ["odd", "even", "all"]) {
      await cleanupZones();
      const res = await supertest(app)
        .post("/api/warehouse-zones")
        .send({ ...BASE_ZONE, sectionParity: parity })
        .expect(201);
      expect(res.body.zone.sectionParity).toBe(parity);
    }
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send({ aisleId: "A1", label: `${ZONE_LABEL_PREFIX}BAD` })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when sectionParity is an invalid value", async () => {
    const res = await supertest(app)
      .post("/api/warehouse-zones")
      .send({ ...BASE_ZONE, sectionParity: "invalid" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/odd|even|all/i);
  });

  it("returns 403 in production mode", async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await supertest(app)
        .post("/api/warehouse-zones")
        .send(BASE_ZONE)
        .expect(403);

      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toMatch(/disabled in production/i);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/warehouse-zones/:id", () => {
  it("updates the label and returns the updated zone", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;
    const newLabel = `${ZONE_LABEL_PREFIX}UPDATED`;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .send({ label: newLabel })
      .expect(200);

    expect(res.body.zone.label).toBe(newLabel);
    expect(res.body.zone.id).toBe(id);
  });

  it("updates svgX, svgY coordinates", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .send({ svgX: 99, svgY: 88 })
      .expect(200);

    expect(res.body.zone.svgX).toBe(99);
    expect(res.body.zone.svgY).toBe(88);
  });

  it("returns 404 when the zone id does not exist", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/999999999")
      .send({ label: `${ZONE_LABEL_PREFIX}GHOST` })
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await supertest(app)
      .patch("/api/warehouse-zones/not-a-number")
      .send({ label: `${ZONE_LABEL_PREFIX}X` })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for an invalid sectionParity in the update", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .patch(`/api/warehouse-zones/${id}`)
      .send({ sectionParity: "bad-value" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 in production mode", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await supertest(app)
        .patch(`/api/warehouse-zones/${id}`)
        .send({ label: `${ZONE_LABEL_PREFIX}PROD` })
        .expect(403);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/warehouse-zones/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("DELETE /api/warehouse-zones/:id", () => {
  it("deletes a zone and returns deleted: true", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const res = await supertest(app)
      .delete(`/api/warehouse-zones/${id}`)
      .expect(200);

    expect(res.body).toEqual({ deleted: true });
  });

  it("zone no longer appears in the list after deletion", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;
    await supertest(app).delete(`/api/warehouse-zones/${id}`).expect(200);

    const list = await supertest(app).get("/api/warehouse-zones").expect(200);
    const found = list.body.zones.find(
      (z: { id: number }) => z.id === id,
    );
    expect(found).toBeUndefined();
  });

  it("returns 404 when deleting a zone that does not exist", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/999999999")
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await supertest(app)
      .delete("/api/warehouse-zones/not-a-number")
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 in production mode", async () => {
    const create = await supertest(app)
      .post("/api/warehouse-zones")
      .send(BASE_ZONE)
      .expect(201);

    const id: number = create.body.zone.id;

    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await supertest(app)
        .delete(`/api/warehouse-zones/${id}`)
        .expect(403);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
