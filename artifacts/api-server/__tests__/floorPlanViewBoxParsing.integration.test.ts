/**
 * Regression tests for viewBox parsing/normalisation in the floor-plan tile
 * pipeline (parseSvgViewBox + normalizeViewBoxOrigin in routes/floorPlan.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * Those helpers originally matched only DOUBLE-quoted `viewBox="…"` attributes.
 * SVGs exported by some tools use SINGLE quotes (`viewBox='…'`), which silently
 * fell through to SVG_ASPECT_FALLBACK and produced a mis-shaped tile pyramid,
 * and skipped origin normalisation so tiles were offset from the zone overlay.
 *
 * HOW IT WORKS
 * ------------
 * The stored SVG is mocked to return a SINGLE-quoted viewBox with a non-zero
 * origin and a 2:1 aspect ratio (`viewBox='100 200 800 400'`).  sharp is mocked
 * so we can inspect (a) the buffer handed to sharp() — proving the origin was
 * rewritten to "0 0 800 400" — and (b) the resize() dimensions — proving the
 * 2:1 aspect was parsed from the single-quoted attribute rather than the
 * hardcoded fallback.
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

// ── Mock objectStorage — return a SINGLE-quoted, non-zero-origin viewBox ───────
// The name begins with `mock` so Jest's hoisted factory may reference it, and it
// is re-used below to derive the seeded hash (generateTile verifies the buffer
// hash matches the requested floor-plan hash).
const mockSingleQuoteSvg =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='100 200 800 400'>" +
  "<rect x='0' y='0' width='800' height='400' fill='green'/></svg>";

jest.mock("../src/lib/objectStorage", () => ({
  readFloorPlanSvg: jest.fn(() => Promise.resolve(Buffer.from(mockSingleQuoteSvg, "utf8"))),
  uploadFloorPlanSvg: jest.fn(),
  uploadCatalogImage: jest.fn(),
}));

// ── Mock sharp — capture the input buffer and resize() dimensions ─────────────
const mockFakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const mockResize = jest.fn().mockReturnThis();
const mockSharpInstance = {
  resize: mockResize,
  extract: jest.fn().mockReturnThis(),
  png: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(mockFakePng),
};
const mockSharpFn = jest.fn((_input?: unknown) => mockSharpInstance);

jest.mock("sharp", () => mockSharpFn);

// ── Imports ───────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import supertest from "supertest";
import app from "../src/app";
import { db, floorPlanMetaTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Test fixture constants ────────────────────────────────────────────────────
const TEST_HASH = crypto.createHash("sha256").update(mockSingleQuoteSvg).digest("hex");
const TEST_OBJECT_PATH = "/objects/jest-test/floor-plan/single-quote.svg";

// Tile-pyramid constants mirror routes/floorPlan.ts (TILE_PX=512, z0 => 1×1).
const TILE_PX = 512;
const EXPECTED_ASPECT = 800 / 400; // 2:1 from viewBox="… 800 400"
const EXPECTED_TOTAL_W = TILE_PX; // gridSize=1 at z0
const EXPECTED_TOTAL_H = Math.round(EXPECTED_TOTAL_W / EXPECTED_ASPECT);

async function seedFloorPlan() {
  await db
    .insert(floorPlanMetaTable)
    .values({ objectPath: TEST_OBJECT_PATH, hash: TEST_HASH })
    .onConflictDoNothing();
}

async function cleanupFloorPlan() {
  await db.delete(floorPlanMetaTable).where(eq(floorPlanMetaTable.hash, TEST_HASH));
}

beforeAll(async () => {
  // Ensure a clean cache miss so sharp() actually runs for this hash.
  await fs
    .unlink(path.join(os.tmpdir(), "floor-plan-tiles", `${TEST_HASH}_0_0_0.png`))
    .catch(() => {});
  await seedFloorPlan();
}, 15_000);

afterAll(async () => {
  await cleanupFloorPlan();
  await pool.end();
}, 15_000);

describe("floor-plan tiles — single-quoted viewBox parsing & origin normalisation", () => {
  it("returns 200 + image/png for a z0 tile from a single-quoted-viewBox SVG", async () => {
    const res = await supertest(app).get("/api/floor-plan/tiles/0/0/0").expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("normalises a non-zero, single-quoted viewBox origin to '0 0 W H' before rasterising", () => {
    expect(mockSharpFn).toHaveBeenCalled();
    const inputBuf = mockSharpFn.mock.calls[0][0] as unknown as Buffer;
    const svgStr = inputBuf.toString("utf8");
    expect(svgStr).toContain('viewBox="0 0 800 400"');
    // The original single-quoted, non-zero-origin viewBox must be gone.
    expect(svgStr).not.toContain("viewBox='100 200 800 400'");
  });

  it("derives the tile aspect ratio from the single-quoted viewBox (not the fallback)", () => {
    expect(mockResize).toHaveBeenCalledWith(
      EXPECTED_TOTAL_W,
      EXPECTED_TOTAL_H,
      { fit: "fill" },
    );
  });
});
