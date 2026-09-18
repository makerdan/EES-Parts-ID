/**
 * Tests for GET /api/floor-plan/tiles when no floor plan has been uploaded.
 *
 * The real database is not used here — @workspace/db is fully mocked so that
 * getLatestMeta() always returns null, regardless of what rows exist in the
 * shared dev database. The bundled floor plan remains available as the public
 * bootstrap layout.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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

// ── Mock @workspace/db so getLatestMeta() returns null ───────────────────────
// The tile route calls:
//   db.select().from(floorPlanMetaTable).orderBy(...).limit(1)
// We intercept the full drizzle query chain and resolve with an empty array.
jest.mock("@workspace/db", () => {
  const limitMock = jest.fn().mockResolvedValue([]);
  const orderByMock = jest.fn(() => ({ limit: limitMock }));
  const fromMock = jest.fn(() => ({ orderBy: orderByMock }));
  const selectMock = jest.fn(() => ({ from: fromMock }));

  return {
    db: { select: selectMock },
    floorPlanMetaTable: {},
    pool: { end: jest.fn().mockResolvedValue(undefined) },
    inventoryTable: {},
    warehouseZoneTable: {},
  };
});

// ── Mock objectStorage — not reached when there is no floor plan, but the
//    module is still imported by the route file so it must be mockable ─────────
jest.mock("../src/lib/objectStorage", () => ({
  readFloorPlanSvg: jest.fn(),
  uploadFloorPlanSvg: jest.fn(),
  uploadCatalogImage: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";

// ─────────────────────────────────────────────────────────────────────────────
// Suite — no floor plan in DB → bundled fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/floor-plan/tiles — no floor plan uploaded", () => {
  it("returns the bundled fallback tile for z=0 when no upload exists", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns the bundled fallback tile at z=4 when no upload exists", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/4/7/7")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns the bundled fallback tile with .png suffix", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0.png")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });
});
