/**
 * Integration tests — idempotent chunk upload (duplicate child-job prevention).
 *
 * Covers POST /api/admin/catalog-pdf with a (parentJobId, chunkIndex) pair
 * that already has a child job in the DB.  The route must:
 *   1. Return the existing child job ID rather than inserting a new row.
 *   2. Leave exactly one child job row in the DB for that slot.
 *   3. Not create a duplicate inventory update (background processing runs
 *      only for the first submission).
 */

// ── Module mocks — must come before any imports ───────────────────────────────

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
  return { tryPoeBotChain: jest.fn(), PoeBotChainExhaustedError };
});

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(),
  validatePdf: jest.fn(),
}));

jest.mock("../src/utils/catalogExtractor", () => ({
  extractCatalogPage: jest.fn(),
}));

jest.mock("../src/utils/catalogMatcher", () => ({
  matchCatalogNumber: jest.fn(),
}));

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import { closePool } from "./helpers/testDb";
import { db, catalogPdfJobTable } from "@workspace/db";
import { and, count, eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage } from "../src/utils/catalogExtractor";

// ── Typed mocks ───────────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-dup-chunk-secret";
const VENDOR = "JEST-DUP-CHUNK-VENDOR";
const STUB_PDF_B64 = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");

// ── State ─────────────────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedParentJob(chunkCount: number): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "jest-dup-chunk.pdf",
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
      chunkCount,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed parent job");
  seededJobIds.push(row.id);
  return row.id;
}

async function countChildJobs(parentId: number, chunkIndex: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(catalogPdfJobTable)
    .where(
      and(
        eq(catalogPdfJobTable.parentJobId, parentId),
        eq(catalogPdfJobTable.chunkIndex, chunkIndex),
      ),
    );
  return Number(row?.n ?? 0);
}

async function getChildJob(parentId: number, chunkIndex: number) {
  const [row] = await db
    .select({
      id: catalogPdfJobTable.id,
      status: catalogPdfJobTable.status,
      processedPages: catalogPdfJobTable.processedPages,
    })
    .from(catalogPdfJobTable)
    .where(
      and(
        eq(catalogPdfJobTable.parentJobId, parentId),
        eq(catalogPdfJobTable.chunkIndex, chunkIndex),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
}, 15_000);

afterEach(() => {
  jest.clearAllMocks();
  mockExtractCatalogPage.mockResolvedValue({ entries: [], rawText: "" });
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededJobIds));
  }
  await closePool();
}, 15_000);

// =============================================================================
// Suite: duplicate chunk upload returns existing child job
// =============================================================================

describe("POST /api/admin/catalog-pdf — duplicate (parentJobId, chunkIndex) handling", () => {
  it(
    "returns the existing child job ID when the same chunk is submitted a second time",
    async () => {
      const parentId = await seedParentJob(2);

      mockExtractPdfPages.mockResolvedValue([
        { pageNum: 0, text: "page0", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      ]);

      const payload = {
        pdfBase64: STUB_PDF_B64,
        vendor: VENDOR,
        filename: "jest-dup-chunk.pdf",
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentId,
        pageOffset: 0,
      };

      const first = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);

      const firstChunkJobId = first.body.chunkJobId as string;
      expect(firstChunkJobId).toBeDefined();
      seededJobIds.push(Number(firstChunkJobId));

      const second = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);

      expect(second.body.chunkJobId).toBe(firstChunkJobId);
      expect(second.body.jobId).toBe(String(parentId));
    },
    20_000,
  );

  it(
    "leaves exactly one child job row in the DB after a duplicate submission",
    async () => {
      const parentId = await seedParentJob(2);

      mockExtractPdfPages.mockResolvedValue([
        { pageNum: 0, text: "page0", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      ]);

      const payload = {
        pdfBase64: STUB_PDF_B64,
        vendor: VENDOR,
        filename: "jest-dup-chunk.pdf",
        chunkIndex: 1,
        chunkCount: 2,
        parentJobId: parentId,
        pageOffset: 0,
      };

      const first = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);
      seededJobIds.push(Number(first.body.chunkJobId));

      await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);

      const n = await countChildJobs(parentId, 1);
      expect(n).toBe(1);
    },
    20_000,
  );

  it(
    "includes a status field in the response for the existing child job",
    async () => {
      const parentId = await seedParentJob(3);

      mockExtractPdfPages.mockResolvedValue([]);

      const payload = {
        pdfBase64: STUB_PDF_B64,
        vendor: VENDOR,
        filename: "jest-dup-chunk.pdf",
        chunkIndex: 0,
        chunkCount: 3,
        parentJobId: parentId,
        pageOffset: 0,
      };

      const first = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);
      seededJobIds.push(Number(first.body.chunkJobId));

      const second = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);

      expect(typeof second.body.status).toBe("string");
      expect(["pending", "processing", "done", "failed", "cancelled"]).toContain(
        second.body.status,
      );
    },
    20_000,
  );

  it(
    "does not re-trigger background processing for a duplicate chunk submission",
    async () => {
      const parentId = await seedParentJob(2);
      const PAGES = [
        { pageNum: 0, text: "dup-page", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
      ];
      mockExtractPdfPages.mockResolvedValue(PAGES);

      const payload = {
        pdfBase64: STUB_PDF_B64,
        vendor: VENDOR,
        filename: "jest-dup-chunk.pdf",
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentId,
        pageOffset: 0,
      };

      const first = await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);
      seededJobIds.push(Number(first.body.chunkJobId));

      await new Promise((r) => setTimeout(r, 200));
      const callsAfterFirst = mockExtractCatalogPage.mock.calls.length;

      mockExtractPdfPages.mockResolvedValue(PAGES);
      await supertest(app)
        .post("/api/admin/catalog-pdf")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(payload)
        .expect(200);

      await new Promise((r) => setTimeout(r, 200));
      expect(mockExtractCatalogPage.mock.calls.length).toBe(callsAfterFirst);
    },
    20_000,
  );
});
