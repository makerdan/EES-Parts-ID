/**
 * Tests for GET /api/floor-plan/tiles when no floor plan has been uploaded.
 *
 * The real database is not used here — @workspace/db is fully mocked so that
 * getLatestMeta() always returns null, regardless of what rows exist in the
 * shared dev database.  This makes the 404 behaviour testable in isolation.
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
// Suite — no floor plan in DB → 404
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/floor-plan/tiles — no floor plan uploaded", () => {
  it("returns 404 for z=0 tile when no floor plan exists", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 for a z=4 tile when no floor plan exists", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/4/7/7")
      .expect(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 with .png suffix when no floor plan exists", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0.png")
      .expect(404);
    expect(res.body).toHaveProperty("error");
  });
});
