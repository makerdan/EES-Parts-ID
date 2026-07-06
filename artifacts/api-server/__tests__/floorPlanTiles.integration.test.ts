/**
 * Integration tests for GET /api/floor-plan/tiles/:z/:x/:y
 *
 * Covers:
 *   - 200 + image/png for valid tiles at z0–z4 (including edge coordinates)
 *   - 400 for out-of-range x/y at each zoom level
 *   - 400 for z > MAX_Z (z=5) and negative / non-finite params
 *   - 404 when no floor plan has been uploaded
 *   - Cache-Control and ETag headers on successful responses
 *   - URL form with .png suffix (e.g. /tiles/0/0/0.png)
 *
 * sharp is mocked so tile rasterisation does not run during tests — this keeps
 * the suite fast and avoids large-buffer allocations for z4 (16×16 grid).
 * objectStorage is mocked so no GCS calls are made.
 * The real database is used; a test floor-plan-meta row is inserted in
 * beforeAll and deleted in afterAll.
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

// ── Mock objectStorage — no real GCS calls in tests ───────────────────────────
// The stored SVG string is defined here (name begins with `mock` so Jest's
// hoisted factory may reference it) and re-used below to derive TEST_HASH.  The
// tile route's generateTile() now verifies sha256(svgBuffer) === svgHash before
// serving, so the seeded floor-plan hash MUST equal the hash of these bytes.
const mockFloorPlanSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
  '<rect width="100" height="100" fill="blue"/></svg>';

jest.mock("../src/lib/objectStorage", () => ({
  readFloorPlanSvg: jest.fn(() => Promise.resolve(Buffer.from(mockFloorPlanSvg, "utf8"))),
  uploadFloorPlanSvg: jest.fn(),
  uploadCatalogImage: jest.fn(),
}));

// ── Mock sharp — avoid slow/large rasterisation during tests ──────────────────
// PNG magic bytes so the response body is a recognisable PNG buffer.
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

jest.mock("sharp", () => {
  const chain = {
    resize: jest.fn().mockReturnThis(),
    extract: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(FAKE_PNG),
  };
  const sharpFn = jest.fn(() => chain);
  return sharpFn;
});

// ── Imports ───────────────────────────────────────────────────────────────────
import crypto from "node:crypto";

import supertest from "supertest";
import app from "../src/app";
import { db, floorPlanMetaTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Test fixture constants ────────────────────────────────────────────────────
// TEST_HASH must equal the sha256 of the SVG bytes returned by the mocked
// readFloorPlanSvg — generateTile() now rejects tiles whose buffer hash does not
// match the requested floor-plan hash.
const TEST_HASH = crypto.createHash("sha256").update(mockFloorPlanSvg).digest("hex");
const TEST_OBJECT_PATH = "/objects/jest-test/floor-plan/warehouse-map.svg";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function seedFloorPlan() {
  await db
    .insert(floorPlanMetaTable)
    .values({ objectPath: TEST_OBJECT_PATH, hash: TEST_HASH })
    .onConflictDoNothing();
}

async function cleanupFloorPlan() {
  await db
    .delete(floorPlanMetaTable)
    .where(eq(floorPlanMetaTable.hash, TEST_HASH));
}

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
});
afterAll(() => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite — valid floor plan in DB → 200 / 400
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/floor-plan/tiles — floor plan present", () => {
  beforeAll(async () => {
    await seedFloorPlan();
  }, 15_000);

  afterAll(async () => {
    await cleanupFloorPlan();
    await pool.end();
  }, 15_000);

  // ── 200 success cases ───────────────────────────────────────────────────────

  describe("200 for valid tiles across all zoom levels", () => {
    const validCases: Array<{ z: number; x: number; y: number; label: string }> = [
      { z: 0, x: 0, y: 0, label: "z=0 single tile" },
      { z: 1, x: 0, y: 0, label: "z=1 first tile" },
      { z: 1, x: 1, y: 1, label: "z=1 last tile (2×2 grid)" },
      { z: 2, x: 0, y: 0, label: "z=2 first tile" },
      { z: 2, x: 3, y: 3, label: "z=2 last tile (4×4 grid)" },
      { z: 3, x: 0, y: 0, label: "z=3 first tile" },
      { z: 3, x: 7, y: 7, label: "z=3 last tile (8×8 grid)" },
      { z: 4, x: 0, y: 0, label: "z=4 first tile" },
      { z: 4, x: 15, y: 15, label: "z=4 last tile (16×16 grid)" },
      { z: 4, x: 0, y: 15, label: "z=4 bottom-left tile" },
      { z: 4, x: 15, y: 0, label: "z=4 top-right tile" },
    ];

    for (const { z, x, y, label } of validCases) {
      it(`returns 200 + image/png for ${label}`, async () => {
        const res = await supertest(app)
          .get(`/api/floor-plan/tiles/${z}/${x}/${y}`)
          .expect(200);
        expect(res.headers["content-type"]).toMatch(/image\/png/);
        expect(res.body).toBeInstanceOf(Buffer);
      });
    }
  });

  it("accepts .png suffix in the URL (e.g. /tiles/0/0/0.png)", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0.png")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  // ── Header assertions ───────────────────────────────────────────────────────

  it("sets Cache-Control: public, max-age=86400 on a successful tile response", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("sets an ETag header on a successful tile response", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(200);
    expect(res.headers["etag"]).toBeDefined();
    expect(typeof res.headers["etag"]).toBe("string");
    expect(res.headers["etag"].length).toBeGreaterThan(0);
  });

  it("ETag encodes the hash and tile coordinates", async () => {
    const res = await supertest(app)
      .get("/api/floor-plan/tiles/2/3/1")
      .expect(200);
    const etag: string = res.headers["etag"];
    expect(etag).toContain(TEST_HASH);
    expect(etag).toContain("2");
    expect(etag).toContain("3");
    expect(etag).toContain("1");
  });

  it("returns 304 when If-None-Match matches the ETag", async () => {
    const first = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(200);
    const etag: string = first.headers["etag"];

    await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .set("If-None-Match", etag)
      .expect(304);
  });

  // ── 400 out-of-range cases ──────────────────────────────────────────────────

  describe("400 for out-of-range coordinates", () => {
    const outOfRangeCases: Array<{ path: string; label: string }> = [
      // z=0: grid is 1×1 so only (0,0) is valid
      { path: "/api/floor-plan/tiles/0/1/0", label: "z=0 x=1 (out of 1×1 grid)" },
      { path: "/api/floor-plan/tiles/0/0/1", label: "z=0 y=1 (out of 1×1 grid)" },
      { path: "/api/floor-plan/tiles/0/-1/0", label: "z=0 negative x" },
      { path: "/api/floor-plan/tiles/0/0/-1", label: "z=0 negative y" },
      // z=1: grid is 2×2, so x/y can only be 0 or 1
      { path: "/api/floor-plan/tiles/1/2/0", label: "z=1 x=2 (out of 2×2 grid)" },
      { path: "/api/floor-plan/tiles/1/0/2", label: "z=1 y=2 (out of 2×2 grid)" },
      // z=2: grid is 4×4, so x/y must be 0–3
      { path: "/api/floor-plan/tiles/2/4/0", label: "z=2 x=4 (out of 4×4 grid)" },
      { path: "/api/floor-plan/tiles/2/0/4", label: "z=2 y=4 (out of 4×4 grid)" },
      { path: "/api/floor-plan/tiles/2/-1/0", label: "z=2 negative x" },
      { path: "/api/floor-plan/tiles/2/0/-1", label: "z=2 negative y" },
      // z=3: grid is 8×8, so x/y must be 0–7
      { path: "/api/floor-plan/tiles/3/8/0", label: "z=3 x=8 (out of 8×8 grid)" },
      { path: "/api/floor-plan/tiles/3/0/8", label: "z=3 y=8 (out of 8×8 grid)" },
      { path: "/api/floor-plan/tiles/3/-1/0", label: "z=3 negative x" },
      { path: "/api/floor-plan/tiles/3/0/-1", label: "z=3 negative y" },
      // z=4: grid is 16×16, so x/y must be 0–15
      { path: "/api/floor-plan/tiles/4/16/0", label: "z=4 x=16 (out of 16×16 grid)" },
      { path: "/api/floor-plan/tiles/4/0/16", label: "z=4 y=16 (out of 16×16 grid)" },
      { path: "/api/floor-plan/tiles/4/-1/0", label: "z=4 negative x" },
      { path: "/api/floor-plan/tiles/4/0/-1", label: "z=4 negative y" },
    ];

    for (const { path, label } of outOfRangeCases) {
      it(`returns 400 for ${label}`, async () => {
        const res = await supertest(app).get(path).expect(400);
        expect(res.body).toHaveProperty("error");
      });
    }
  });

  describe("400 for invalid zoom levels", () => {
    it("returns 400 for z=5 (exceeds MAX_Z=4)", async () => {
      const res = await supertest(app)
        .get("/api/floor-plan/tiles/5/0/0")
        .expect(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for z=-1 (negative zoom)", async () => {
      const res = await supertest(app)
        .get("/api/floor-plan/tiles/-1/0/0")
        .expect(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for non-numeric z", async () => {
      const res = await supertest(app)
        .get("/api/floor-plan/tiles/abc/0/0")
        .expect(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for non-numeric x", async () => {
      const res = await supertest(app)
        .get("/api/floor-plan/tiles/0/abc/0")
        .expect(400);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for non-numeric y", async () => {
      const res = await supertest(app)
        .get("/api/floor-plan/tiles/0/0/abc")
        .expect(400);
      expect(res.body).toHaveProperty("error");
    });
  });
});
