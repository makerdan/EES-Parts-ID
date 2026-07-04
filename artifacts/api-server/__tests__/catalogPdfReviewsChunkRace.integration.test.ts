/**
 * Integration tests for GET /api/admin/catalog-pdf/reviews?jobId=<n>
 * covering the chunk-race scenario.
 *
 * Background: the optimistic-lock UPDATE in processPdfPages sets
 * catalogPdfJobId to the *winning child* job, not the parent.  Before the
 * fix, querying the reviews endpoint with ?jobId=<parentJobId> would silently
 * drop those rows because the filter was a direct equality check
 * (catalogPdfJobId = parentJobId).
 *
 * After the fix the endpoint expands the filter to include all child jobs
 * whose parent_job_id equals the requested jobId, so every enriched part
 * appears regardless of which chunk won the race.
 */

// ── Module mocks — must appear before any imports ─────────────────────────────

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

jest.mock("../src/lib/poeBot", () => {
  class PoeBotChainExhaustedError extends Error {
    constructor() {
      super("All Poe bots in the fallback chain failed");
      this.name = "PoeBotChainExhaustedError";
    }
  }
  return {
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (c: unknown, m: string) => unknown) =>
      fn({}, "test-model"),
    ),
    PoeBotChainExhaustedError,
  };
});

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(),
  validatePdf: jest.fn(),
}));

jest.mock("../src/utils/catalogExtractor", () => {
  const actual = jest.requireActual<typeof import("../src/utils/catalogExtractor")>(
    "../src/utils/catalogExtractor",
  );
  return {
    ...actual,
    extractCatalogPage: jest.fn(),
  };
});

jest.mock("../src/utils/catalogMatcher", () => ({
  matchCatalogNumber: jest.fn(),
}));

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, catalogPdfJobTable, inventoryTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ── Constants ──────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-reviews-chunk-race-secret";
const VENDOR = "JEST-CHUNK-RACE-VENDOR";

// ── Cleanup tracking ───────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];
const seededInventoryIds: number[] = [];

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

afterAll(async () => {
  if (seededInventoryIds.length > 0) {
    await db.delete(inventoryTable).where(inArray(inventoryTable.id, seededInventoryIds));
  }
  if (seededJobIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
  await closePool();
}, 15_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Insert a parent job and two child jobs; return all three IDs. */
async function seedMultiChunkJob(): Promise<{
  parentId: number;
  child0Id: number;
  child1Id: number;
}> {
  const [parent] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "race-test.pdf",
      status: "done",
      processedPages: 10,
      matchedParts: 2,
      chunkCount: 2,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!parent) throw new Error("Failed to seed parent job");
  seededJobIds.push(parent.id);

  const [child0] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "race-test.pdf",
      status: "done",
      processedPages: 5,
      matchedParts: 1,
      parentJobId: parent.id,
      chunkIndex: 0,
      chunkCount: 2,
      pageOffset: 0,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!child0) throw new Error("Failed to seed child job 0");
  seededJobIds.push(child0.id);

  const [child1] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "race-test.pdf",
      status: "done",
      processedPages: 5,
      matchedParts: 1,
      parentJobId: parent.id,
      chunkIndex: 1,
      chunkCount: 2,
      pageOffset: 5,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!child1) throw new Error("Failed to seed child job 1");
  seededJobIds.push(child1.id);

  return { parentId: parent.id, child0Id: child0.id, child1Id: child1.id };
}

/** Seed an inventory row that was enriched by the given child job. */
async function seedEnrichedPart(catalog: string, childJobId: number): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: VENDOR,
      catalog,
      description: `Updated by chunk-race test ${catalog}`,
      previousDescription: `Original description ${catalog}`,
      imageSource: "pdf_extraction",
      imageConfidence: 0.85,
      catalogPdfJobId: childJobId,
      binLocations: [],
      aiKeywords: [],
    })
    .returning({ id: inventoryTable.id });
  if (!row) throw new Error(`Failed to seed enriched part ${catalog}`);
  seededInventoryIds.push(row.id);
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/catalog-pdf/reviews — chunk race visibility", () => {
  it("returns rows whose catalogPdfJobId belongs to a child job when querying the parent", async () => {
    const { parentId, child0Id, child1Id } = await seedMultiChunkJob();

    // Part A was enriched by chunk 0 (the "expected" winner)
    const partAId = await seedEnrichedPart(`RACE-A-${parentId}`, child0Id);
    // Part B was enriched by chunk 1 (a different winning chunk in a race)
    const partBId = await seedEnrichedPart(`RACE-B-${parentId}`, child1Id);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/reviews?jobId=${parentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as {
      items: Array<{ id: number; catalogPdfJobId: number; job: { id: number } | null }>;
      total: number;
    };

    const returnedIds = body.items.map((i) => i.id);
    expect(returnedIds).toContain(partAId);
    expect(returnedIds).toContain(partBId);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the parent job as the display job for rows won by a child chunk", async () => {
    const { parentId, child1Id } = await seedMultiChunkJob();
    const partId = await seedEnrichedPart(`RACE-DISP-${parentId}`, child1Id);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/reviews?jobId=${parentId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as {
      items: Array<{ id: number; catalogPdfJobId: number; job: { id: number } | null }>;
    };

    const item = body.items.find((i) => i.id === partId);
    expect(item).toBeDefined();
    // The row's raw catalogPdfJobId is the child, but the display job should be the parent.
    expect(item!.catalogPdfJobId).toBe(child1Id);
    expect(item!.job?.id).toBe(parentId);
  });

  it("returns rows normally when catalogPdfJobId already matches the queried job directly", async () => {
    // Single-chunk scenario: inventory row points directly to the queried job
    const [directJob] = await db
      .insert(catalogPdfJobTable)
      .values({
        vendor: VENDOR,
        filename: "direct-test.pdf",
        status: "done",
        processedPages: 3,
        matchedParts: 1,
      })
      .returning({ id: catalogPdfJobTable.id });
    if (!directJob) throw new Error("Failed to seed direct job");
    seededJobIds.push(directJob.id);

    const partId = await seedEnrichedPart(`DIRECT-${directJob.id}`, directJob.id);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/reviews?jobId=${directJob.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as {
      items: Array<{ id: number; job: { id: number } | null }>;
    };

    const item = body.items.find((i) => i.id === partId);
    expect(item).toBeDefined();
    expect(item!.job?.id).toBe(directJob.id);
  });

  it("excludes rows from a different parent job", async () => {
    const { parentId: parentA, child0Id: childA } = await seedMultiChunkJob();
    const { parentId: parentB, child0Id: childB } = await seedMultiChunkJob();

    await seedEnrichedPart(`EXCL-A-${parentA}`, childA);
    const partBId = await seedEnrichedPart(`EXCL-B-${parentB}`, childB);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/reviews?jobId=${parentB}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as { items: Array<{ id: number }> };
    const returnedIds = body.items.map((i) => i.id);

    // Part from parent B's child should appear
    expect(returnedIds).toContain(partBId);

    // Parts from parent A's child must not bleed into parent B's result
    const partAItem = body.items.find((i) => {
      const item = i as { id: number; catalogPdfJobId: number };
      return item.catalogPdfJobId === childA;
    });
    expect(partAItem).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/catalog-pdf/reviews/:id/revert — chunk-race context guard
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — chunk-race context guard", () => {
  it("reverts a chunk-race winner when jobId is the parent job", async () => {
    const { parentId, child1Id } = await seedMultiChunkJob();
    const partId = await seedEnrichedPart(`REVERT-CHILD-${parentId}`, child1Id);

    // The item's catalogPdfJobId is child1Id, but the admin passes parentId —
    // the guard must resolve child jobs and allow the revert.
    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${partId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ jobId: parentId })
      .expect(200);

    expect(res.body).toMatchObject({ ok: true });

    // Confirm the row was actually cleared
    const [updated] = await db
      .select({
        imageSource: inventoryTable.imageSource,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
        description: inventoryTable.description,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, partId))
      .limit(1);

    expect(updated?.imageSource).toBeNull();
    expect(updated?.catalogPdfJobId).toBeNull();
    expect(updated?.description).toBe(`Original description REVERT-CHILD-${parentId}`);
  });

  it("reverts a single-chunk item when jobId matches catalogPdfJobId directly", async () => {
    const [directJob] = await db
      .insert(catalogPdfJobTable)
      .values({
        vendor: VENDOR,
        filename: "revert-direct.pdf",
        status: "done",
        processedPages: 2,
        matchedParts: 1,
      })
      .returning({ id: catalogPdfJobTable.id });
    if (!directJob) throw new Error("Failed to seed direct job for revert test");
    seededJobIds.push(directJob.id);

    const partId = await seedEnrichedPart(`REVERT-DIRECT-${directJob.id}`, directJob.id);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${partId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ jobId: directJob.id })
      .expect(200);

    const [updated] = await db
      .select({ imageSource: inventoryTable.imageSource, catalogPdfJobId: inventoryTable.catalogPdfJobId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, partId))
      .limit(1);

    expect(updated?.imageSource).toBeNull();
    expect(updated?.catalogPdfJobId).toBeNull();
  });

  it("rejects revert when the item does not belong to the provided jobId", async () => {
    const { parentId: parentA, child0Id: childA } = await seedMultiChunkJob();
    const { parentId: parentB } = await seedMultiChunkJob();

    // Part belongs to parentA / childA — admin mistakenly tries to revert it
    // from parentB's review screen.
    const partId = await seedEnrichedPart(`REVERT-WRONG-JOB-${parentA}`, childA);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${partId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ jobId: parentB })
      .expect(400);

    expect(res.body).toMatchObject({ error: "Item does not belong to the specified job" });

    // Row must be untouched
    const [unchanged] = await db
      .select({ imageSource: inventoryTable.imageSource, catalogPdfJobId: inventoryTable.catalogPdfJobId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, partId))
      .limit(1);

    expect(unchanged?.imageSource).toBe("pdf_extraction");
    expect(unchanged?.catalogPdfJobId).toBe(childA);
  });

  it("reverts without a jobId context (backward-compatible, no guard applied)", async () => {
    const { child0Id } = await seedMultiChunkJob();
    const partId = await seedEnrichedPart(`REVERT-NO-JOB-${child0Id}`, child0Id);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${partId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    const [updated] = await db
      .select({ imageSource: inventoryTable.imageSource })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, partId))
      .limit(1);

    expect(updated?.imageSource).toBeNull();
  });

  it("returns 400 for an invalid (non-numeric) jobId", async () => {
    const { child0Id } = await seedMultiChunkJob();
    const partId = await seedEnrichedPart(`REVERT-BAD-JOB-${child0Id}`, child0Id);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${partId}/revert`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ jobId: "not-a-number" })
      .expect(400);

    expect(res.body).toMatchObject({ error: "Invalid jobId" });
  });
});
