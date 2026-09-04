/**
 * Anonymous warehouse-layout contract.
 *
 * This test deliberately checks the complete public render path and the
 * adjacent private boundaries in one API-server integration suite:
 *   floor-plan metadata/SVG/tiles + zones/anchors/alignment → public
 *   coverage, inventory, admin, private objects, and writes → protected
 */

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

const PUBLIC_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100"/></svg>';

jest.mock("../src/lib/objectStorage", () => ({
  readFloorPlanSvg: jest.fn(() => Promise.resolve(Buffer.from(PUBLIC_SVG, "utf8"))),
  uploadFloorPlanSvg: jest.fn(),
  uploadCatalogImage: jest.fn(),
}));

jest.mock("sharp", () => {
  const chain = {
    resize: jest.fn().mockReturnThis(),
    extract: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from("public-layout-tile")),
  };
  return jest.fn(() => chain);
});

import crypto from "node:crypto";

import supertest from "supertest";
import { db, floorPlanMetaTable, mapAnchorPointsTable, pool, warehouseZoneTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

import app from "../src/app";

const LAYOUT_AISLE = "JEST-PUBLIC-LAYOUT";
const ANCHOR_PREFIX = "JEST-PUBLIC-ANCHOR-";
const SVG_HASH = crypto.createHash("sha256").update(PUBLIC_SVG).digest("hex");
let insertedAnchorIds: number[] = [];
let expectedAnchors: Array<{
  name: string;
  svgX: number;
  svgY: number;
  worldX: number;
  worldY: number;
}> = [];

async function cleanupFixtures(): Promise<void> {
  await db.delete(warehouseZoneTable).where(eq(warehouseZoneTable.aisleId, LAYOUT_AISLE));
  await db.delete(mapAnchorPointsTable).where(
    sql`${mapAnchorPointsTable.name} LIKE ${`${ANCHOR_PREFIX}%`}`,
  );
  await db.delete(floorPlanMetaTable).where(eq(floorPlanMetaTable.hash, SVG_HASH));
}

beforeAll(async () => {
  process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "jest-public-layout-bucket";
  await cleanupFixtures();
  await db.insert(warehouseZoneTable).values({
    aisleId: LAYOUT_AISLE,
    sectionNum: 7,
    isInventory: true,
    svgX: 10,
    svgY: 20,
    svgWidth: 30,
    svgHeight: 40,
    sortOrder: 9876,
  });
  const existingAnchors = await db.select().from(mapAnchorPointsTable);
  if (existingAnchors.length === 0) {
    const seededAnchors = [
      { id: 1, name: `${ANCHOR_PREFIX}1`, svgX: 10, svgY: 10, worldX: 0, worldY: 0 },
      { id: 2, name: `${ANCHOR_PREFIX}2`, svgX: 90, svgY: 10, worldX: 80, worldY: 0 },
      { id: 3, name: `${ANCHOR_PREFIX}3`, svgX: 10, svgY: 90, worldX: 0, worldY: 80 },
    ];
    await db.insert(mapAnchorPointsTable).values(seededAnchors);
    insertedAnchorIds = seededAnchors.map((anchor) => anchor.id);
    expectedAnchors = seededAnchors.map(({ name, svgX, svgY, worldX, worldY }) => ({
      name, svgX, svgY, worldX, worldY,
    }));
  } else {
    expectedAnchors = existingAnchors.map(({ name, svgX, svgY, worldX, worldY }) => ({
      name, svgX, svgY, worldX, worldY,
    }));
  }
  await db.insert(floorPlanMetaTable).values({
    objectPath: "/objects/uploads/public/floor-plan/warehouse-map.svg",
    hash: SVG_HASH,
    uploadedAt: new Date("2099-01-01T00:00:00.000Z"),
  });
}, 15_000);

afterAll(async () => {
  await cleanupFixtures();
  if (insertedAnchorIds.length > 0) {
    await db.delete(mapAnchorPointsTable).where(inArray(mapAnchorPointsTable.id, insertedAnchorIds));
  }
  delete process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  await pool.end();
}, 15_000);

describe("anonymous warehouse layout", () => {
  it("returns the complete minimized render contract with public cache policy", async () => {
    const [meta, svg, tile, zones, anchors, alignment] = await Promise.all([
      supertest(app).get("/api/floor-plan/meta").expect(200),
      supertest(app).get("/api/floor-plan/svg").expect(200),
      supertest(app).get("/api/floor-plan/tiles/0/0/0").expect(200),
      supertest(app).get("/api/warehouse-zones").expect(200),
      supertest(app).get("/api/warehouse-zones/anchors").expect(200),
      supertest(app).get("/api/warehouse-zones/alignment").expect(200),
    ]);

    expect(meta.headers["cache-control"]).toMatch(/^public,/);
    expect(meta.body).toEqual({ hash: SVG_HASH });
    expect(svg.headers["content-type"]).toMatch(/image\/svg\+xml/);
    expect(svg.headers["cache-control"]).toMatch(/^public,/);
    expect(svg.body.toString("utf8")).toBe(PUBLIC_SVG);
    expect(tile.headers["content-type"]).toMatch(/image\/png/);
    expect(tile.headers["cache-control"]).toBe("public, max-age=86400");
    expect(tile.headers.etag).toContain(SVG_HASH);

    const zone = zones.body.zones.find(
      (candidate: { aisleId: string }) => candidate.aisleId === LAYOUT_AISLE,
    );
    expect(zone).toEqual({
      aisleId: LAYOUT_AISLE,
      sectionNum: 7,
      isInventory: true,
      svgX: 10,
      svgY: 20,
      svgWidth: 30,
      svgHeight: 40,
      sortOrder: 9876,
    });
    expect(Object.keys(zone)).toHaveLength(8);
    expect(zones.headers["cache-control"]).toMatch(/^public,/);

    expect(anchors.body.anchors).toEqual(expectedAnchors);
    expect(Object.keys(anchors.body.anchors[0] ?? {})).toEqual(
      expect.arrayContaining(["name", "svgX", "svgY", "worldX", "worldY"]),
    );
    expect(anchors.body.anchors[0] ?? {}).not.toHaveProperty("id");
    expect(anchors.body.anchors[0] ?? {}).not.toHaveProperty("updatedAt");
    expect(anchors.headers["cache-control"]).toMatch(/^public,/);

    expect(alignment.body).toEqual({
      translateX: expect.any(Number),
      translateY: expect.any(Number),
      scale: expect.any(Number),
    });
    expect(alignment.headers["cache-control"]).toMatch(/^public,/);
  });

  it("keeps inventory-derived, administrative, private-object, and mutation routes protected", async () => {
    const protectedRequests = [
      supertest(app).get("/api/warehouse-zones/coverage"),
      supertest(app).get("/api/inventory"),
      supertest(app).get("/api/admin/users"),
      supertest(app).get("/api/inventory/1/photo"),
      supertest(app).post("/api/warehouse-zones").send({
        aisleId: "ANON-MUST-NOT-WRITE",
        svgX: 0,
        svgY: 0,
        svgWidth: 1,
        svgHeight: 1,
      }),
      supertest(app).put("/api/warehouse-zones/alignment").send({
        translateX: 0,
        translateY: 0,
        scale: 1,
      }),
      supertest(app).post("/api/floor-plan/tiles/warmup"),
    ];

    const responses = await Promise.all(protectedRequests);
    for (const response of responses) {
      expect([401, 403]).toContain(response.status);
      expect(response.body).toHaveProperty("error");
    }
  });
});