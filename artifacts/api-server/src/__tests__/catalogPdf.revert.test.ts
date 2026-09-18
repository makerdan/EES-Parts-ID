/**
 * Integration tests for the job-guard on
 * POST /api/admin/catalog-pdf/reviews/:id/revert
 *
 * Covers:
 * 1. Happy path — revert succeeds when jobId matches the item's catalogPdfJobId directly.
 * 2. Chunk-race winner — revert succeeds when the caller's jobId is the parent and the
 *    item's catalogPdfJobId points to one of its child jobs.
 * 3. Guard path — revert returns 400 when a valid but wrong jobId is supplied.
 * 4. Omitted-jobId — revert still succeeds when no jobId is sent (backward-compat).
 */

// ── Env vars — must be set before any module is imported ──────────────────────
const _origAdminPassword = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = "jest-revert-secret";

afterAll(() => {
  if (_origAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = _origAdminPassword;
});

// ── Mock heavy modules imported by catalogPdf.ts that the revert handler never
//    calls. Without these, the OpenAI / Gemini constructors would attempt real
//    network connections during module initialisation.
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
import { eq, inArray, sql } from "drizzle-orm";
import app from "../app";
import { signAdminToken } from "../../__tests__/helpers/adminAuth";
import { db, inventoryTable, catalogPdfJobTable } from "@workspace/db";

// ── Constants / helpers ───────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-revert-secret";
const CAT_PREFIX = "JEST-ITG-REVERT-";

const seededJobIds: number[] = [];
// Tracks the next chunkIndex to use per parent job so sibling inserts never
// collide on the (parent_job_id, chunk_index) unique partial index.
const childChunkIndexByParent = new Map<number, number>();

function makeAdminToken(): string {
  return signAdminToken(Date.now(), ADMIN_SECRET);
}

/**
 * Insert a minimal catalog_pdf_job row and track its ID for cleanup.
 * Pass `parentJobId` to create a child chunk job; each child under the same
 * parent automatically gets the next available chunkIndex.
 */
async function seedJob(parentJobId: number | null = null): Promise<number> {
  let chunkIndex: number | undefined;
  if (parentJobId !== null) {
    const next = childChunkIndexByParent.get(parentJobId) ?? 0;
    chunkIndex = next;
    childChunkIndexByParent.set(parentJobId, next + 1);
  }

  const [row] = await db
    .insert(catalogPdfJobTable)
    .values(
      parentJobId !== null
        ? {
            vendor: "EATON",
            filename: "jest-revert-test.pdf",
            status: "completed",
            parentJobId,
            chunkIndex: chunkIndex!,
            chunkCount: 2,
            pageOffset: 0,
          }
        : {
            vendor: "EATON",
            filename: "jest-revert-test.pdf",
            status: "completed",
          },
    )
    .returning({ id: catalogPdfJobTable.id });

  if (!row) throw new Error("Failed to seed catalogPdfJob row");
  seededJobIds.push(row.id);
  return row.id;
}

/**
 * Insert an inventory item that looks like it was updated by PDF extraction.
 * The catalog number is prefixed with CAT_PREFIX so it can be bulk-deleted in teardown.
 */
async function seedPdfItem(catalogSuffix: string, jobId: number): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: "EATON",
      catalog: CAT_PREFIX + catalogSuffix,
      description: "Updated by PDF extraction",
      previousDescription: "Original description",
      imageSource: "pdf_extraction",
      imageConfidence: 0.9,
      catalogPdfJobId: jobId,
      binLocations: [],
      aiKeywords: [],
    })
    .returning({ id: inventoryTable.id });

  if (!row) throw new Error("Failed to seed inventory item");
  return row.id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────
// Pre-clean: removes stale JEST-ITG-REVERT-* rows left by a previously
// interrupted run so that the unique (vendor, catalog) index never blocks seeding.
beforeAll(async () => {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CAT_PREFIX + "%"}`);
}, 15_000);

afterAll(async () => {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CAT_PREFIX + "%"}`);

  if (seededJobIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — jobId matches the item's catalogPdfJobId directly
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — happy path (direct match)", () => {
  it("returns 200 and reverts the item when jobId equals the item's catalogPdfJobId", async () => {
    const jobId = await seedJob();
    const itemId = await seedPdfItem("DIRECT", jobId);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({ jobId })
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    const [updated] = await db
      .select({
        description: inventoryTable.description,
        imageSource: inventoryTable.imageSource,
        catalogPdfJobId: inventoryTable.catalogPdfJobId,
        previousDescription: inventoryTable.previousDescription,
      })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);

    expect(updated?.description).toBe("Original description");
    expect(updated?.imageSource).toBeNull();
    expect(updated?.catalogPdfJobId).toBeNull();
    expect(updated?.previousDescription).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Chunk-race winner — item's catalogPdfJobId is a child of the caller's jobId
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — chunk-race winner (child job)", () => {
  it("returns 200 when the caller supplies the parent jobId but the item belongs to a child job", async () => {
    const parentJobId = await seedJob();
    const childJobId = await seedJob(parentJobId);
    const itemId = await seedPdfItem("CHILD", childJobId);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({ jobId: parentJobId })
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    const [updated] = await db
      .select({ imageSource: inventoryTable.imageSource, catalogPdfJobId: inventoryTable.catalogPdfJobId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);

    expect(updated?.imageSource).toBeNull();
    expect(updated?.catalogPdfJobId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Guard path — valid but wrong jobId → 400
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — guard (wrong jobId)", () => {
  it("returns 400 and leaves the item unchanged when a wrong jobId is supplied", async () => {
    const correctJobId = await seedJob();
    const wrongJobId = await seedJob();
    const itemId = await seedPdfItem("WRONG-JOB", correctJobId);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({ jobId: wrongJobId })
      .expect(400);

    expect(res.body).toHaveProperty("error");

    const [unchanged] = await db
      .select({ imageSource: inventoryTable.imageSource, catalogPdfJobId: inventoryTable.catalogPdfJobId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);

    // The item must NOT have been reverted
    expect(unchanged?.imageSource).toBe("pdf_extraction");
    expect(unchanged?.catalogPdfJobId).toBe(correctJobId);
  });

  it("returns 400 even when the wrong jobId is a sibling child job (not the parent)", async () => {
    const parentJobId = await seedJob();
    const siblingA = await seedJob(parentJobId);
    const siblingB = await seedJob(parentJobId);
    const itemId = await seedPdfItem("SIBLING", siblingA);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({ jobId: siblingB })
      .expect(400);

    expect(res.body).toHaveProperty("error");

    const [unchanged] = await db
      .select({ imageSource: inventoryTable.imageSource })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);

    expect(unchanged?.imageSource).toBe("pdf_extraction");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Omitted jobId — backward-compat path (no guard applied)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/reviews/:id/revert — omitted jobId (backward-compat)", () => {
  it("returns 200 and reverts when no jobId is sent in the request body", async () => {
    const jobId = await seedJob();
    const itemId = await seedPdfItem("NO-JOB-ID", jobId);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({})
      .expect(200);

    expect(res.body).toEqual({ ok: true });

    const [updated] = await db
      .select({ imageSource: inventoryTable.imageSource, catalogPdfJobId: inventoryTable.catalogPdfJobId })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, itemId))
      .limit(1);

    expect(updated?.imageSource).toBeNull();
    expect(updated?.catalogPdfJobId).toBeNull();
  });

  it("returns 200 even when jobId is explicitly undefined in body", async () => {
    const jobId = await seedJob();
    const itemId = await seedPdfItem("UNDEF-JOB-ID", jobId);

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/reviews/${itemId}/revert`)
      .set("Authorization", `Bearer ${makeAdminToken()}`)
      .send({ jobId: undefined })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
  });
});
