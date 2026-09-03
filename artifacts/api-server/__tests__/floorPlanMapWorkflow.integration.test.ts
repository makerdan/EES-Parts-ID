/**
 * Cross-boundary regression test for the admin floor-plan replacement flow.
 *
 * The test intentionally keeps the whole workflow in one ordered scenario:
 *
 *   old metadata/tile → protected SVG upload → new metadata/SVG → new tile
 *   → the retrieved SVG is consumed by the web map scene contract
 *
 * PostgreSQL is real, while object storage and sharp are deterministic doubles.
 * The final scene assertion uses the same pure scene builder consumed by
 * WarehouseMapView, rather than re-implementing its viewBox/markup handling.
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

// ── Deterministic object-storage fixture ──────────────────────────────────────
const mockOldSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400">' +
  '<rect id="old-floor-plan" x="0" y="0" width="800" height="400"/></svg>';
const mockReplacementSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 200 1200 600">' +
  '<path id="replacement-floor-plan" d="M100 200H1300V800Z"/></svg>';
const mockOldObjectPath = "/objects/jest-test/floor-plan/old.svg";
const mockReplacementObjectPath = "/objects/jest-test/floor-plan/replacement.svg";
let mockStoredSvg = mockOldSvg;

const mockUploadFloorPlanSvg = jest.fn(async (svg: string) => {
  mockStoredSvg = svg;
  return mockReplacementObjectPath;
});

jest.mock("../src/lib/objectStorage", () => ({
  readFloorPlanSvg: jest.fn(() => Promise.resolve(Buffer.from(mockStoredSvg, "utf8"))),
  uploadFloorPlanSvg: mockUploadFloorPlanSvg,
  uploadCatalogImage: jest.fn(),
}));

// ── Deterministic tile-rasterisation double ───────────────────────────────────
const mockFakePng = Buffer.from("replacement-tile-png", "utf8");
const mockResize = jest.fn().mockReturnThis();
const mockExtract = jest.fn().mockReturnThis();
const mockPng = jest.fn().mockReturnThis();
const mockToBuffer = jest.fn().mockResolvedValue(mockFakePng);
const mockSharpInstance = {
  resize: mockResize,
  extract: mockExtract,
  png: mockPng,
  toBuffer: mockToBuffer,
};
const mockSharpFn = jest.fn((_input: unknown) => mockSharpInstance);

jest.mock("sharp", () => mockSharpFn);

// ── Imports ───────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import supertest from "supertest";
import { db, floorPlanMetaTable, pool } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { createWebSvgScene } from "../../parts-id/utils/webSvgScene";

const OLD_HASH = crypto.createHash("sha256").update(mockOldSvg).digest("hex");
const REPLACEMENT_HASH = crypto
  .createHash("sha256")
  .update(mockReplacementSvg)
  .digest("hex");
const TILE_CACHE_DIR = path.join(os.tmpdir(), "floor-plan-tiles");
const OLD_TILE_PATH = path.join(TILE_CACHE_DIR, `${OLD_HASH}_0_0_0.png`);
const REPLACEMENT_TILE_PATH = path.join(
  TILE_CACHE_DIR,
  `${REPLACEMENT_HASH}_0_0_0.png`,
);
const ADMIN_TOKEN = signAdminToken();

async function deleteFixtureMetadata(): Promise<void> {
  await db
    .delete(floorPlanMetaTable)
    .where(
      inArray(floorPlanMetaTable.hash, [OLD_HASH, REPLACEMENT_HASH]),
    );
}

describe("floor-plan replacement → map rendering workflow", () => {
  beforeAll(async () => {
    process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "jest-floor-plan-bucket";
    await deleteFixtureMetadata();
  }, 15_000);

  afterAll(async () => {
    await deleteFixtureMetadata();
    await fs.rm(OLD_TILE_PATH, { force: true });
    await fs.rm(REPLACEMENT_TILE_PATH, { force: true });
    delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    await pool.end();
  }, 15_000);

  beforeEach(async () => {
    mockStoredSvg = mockOldSvg;
    mockUploadFloorPlanSvg.mockClear();
    mockSharpFn.mockClear();
    mockResize.mockClear();
    mockExtract.mockClear();
    mockPng.mockClear();
    mockToBuffer.mockClear();
    mockToBuffer.mockResolvedValue(mockFakePng);

    await deleteFixtureMetadata();
    await fs.mkdir(TILE_CACHE_DIR, { recursive: true });
    await fs.rm(OLD_TILE_PATH, { force: true });
    await fs.rm(REPLACEMENT_TILE_PATH, { force: true });
    await fs.writeFile(OLD_TILE_PATH, Buffer.from("stale-old-tile", "utf8"));
    await db.insert(floorPlanMetaTable).values({
      objectPath: mockOldObjectPath,
      hash: OLD_HASH,
      uploadedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
  });

  it("uploads, invalidates stale tiles, and renders the replacement SVG", async () => {
    // The shared test database can contain another suite's floor-plan row, so
    // prove the old cache artifact is present directly rather than assuming
    // this fixture owns the global "latest metadata" slot before upload.
    expect(await fs.readFile(OLD_TILE_PATH, "utf8")).toBe("stale-old-tile");

    // Upload through the actual admin-protected endpoint.
    const upload = await supertest(app)
      .post("/api/admin/floor-plan")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ svg: mockReplacementSvg })
      .expect(200);

    expect(upload.body).toEqual({
      hash: REPLACEMENT_HASH,
      objectPath: mockReplacementObjectPath,
    });
    expect(mockUploadFloorPlanSvg).toHaveBeenCalledWith(mockReplacementSvg);
    expect(upload.body.hash).not.toBe(OLD_HASH);
    expect(await fs.stat(OLD_TILE_PATH).catch(() => null)).toBeNull();

    // Metadata is globally ordered because floor_plan_meta intentionally keeps
    // upload history. Make this fixture's newly inserted row the latest without
    // touching rows owned by any other test running against the shared DB.
    await db
      .update(floorPlanMetaTable)
      .set({ uploadedAt: new Date("2099-01-01T00:00:00.000Z") })
      .where(eq(floorPlanMetaTable.hash, REPLACEMENT_HASH));

    // Read back the server-owned metadata and content in the same order as the
    // map viewer: hash first, then SVG bytes when its cache key is a miss.
    const newMeta = await supertest(app).get("/api/floor-plan/meta").expect(200);
    expect(newMeta.body.hash).toBe(REPLACEMENT_HASH);
    expect(newMeta.body.hash).not.toBe(OLD_HASH);

    const svgResponse = await supertest(app)
      .get("/api/floor-plan/svg")
      .expect(200);
    const retrievedSvg = svgResponse.body.toString("utf8");
    expect(retrievedSvg).toBe(mockReplacementSvg);
    expect(retrievedSvg).not.toContain("old-floor-plan");

    // A tile request after replacement must generate/cache the new plan rather
    // than reuse the old hash's artifact.
    const replacementTile = await supertest(app)
      .get("/api/floor-plan/tiles/0/0/0")
      .expect(200);
    expect(replacementTile.body.toString("utf8")).toBe("replacement-tile-png");
    expect(await fs.readFile(REPLACEMENT_TILE_PATH)).toEqual(mockFakePng);
    expect(mockSharpFn).toHaveBeenCalledTimes(1);
    const rasterizedSvg = (
      mockSharpFn.mock.calls[0]![0] as Buffer
    ).toString("utf8");
    expect(rasterizedSvg).toContain('viewBox="0 0 1200 600"');
    expect(rasterizedSvg).toContain("replacement-floor-plan");
    expect(rasterizedSvg).not.toContain("old-floor-plan");

    // This is the actual web scene contract used by WarehouseMapView. It proves
    // the retrieved replacement reaches the map with new artwork, a valid
    // normalized frame, and dimensions derived from the replacement SVG.
    const scene = createWebSvgScene(retrievedSvg, 600, 300);
    expect(scene.viewBox).toBe("0 0 1200 600");
    expect(scene.contentViewBox).toEqual({
      x: 100,
      y: 200,
      w: 1200,
      h: 600,
    });
    expect(scene.svgMarkup).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 600" width="600" height="300">',
    );
    expect(scene.svgMarkup).toContain("replacement-floor-plan");
    expect(scene.svgMarkup).not.toContain("old-floor-plan");
  });
});