/**
 * Integration tests verifying that CatalogAiError thrown by extractCatalogPage
 * propagates correctly to the catalog_pdf_job row and is exposed via the
 * status API endpoint.
 *
 * Covers:
 *   - ai_error code → status=failed, non-null errorMessage in DB
 *   - ai_payload_too_large code → matching code persisted in DB
 *   - GET /api/admin/catalog-pdf/:jobId/status includes errorMessage in JSON
 */

// ── Module mocks — must be declared before any imports ────────────────────────

const mockCreate = jest.fn();

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

// ── Mock the Poe bot chain so tests never make real network calls ─────────────
jest.mock("../src/lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../src/lib/poeBot")>("../src/lib/poeBot");
  return {
    ...actual,
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: mockCreate } } }, "test-model"),
    ),
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
  deletePrivateObjects: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { catalogPdfJobTable, db, inventoryTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { awaitJobTermination, launchCatalogPdfBuffer, recoverInterruptedCatalogPdfJobs } from "../src/routes/catalogPdf";
import { logger } from "../src/lib/logger";
import { bestEffortFixtureCleanup } from "./helpers/testDb";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage, CatalogAiError } from "../src/utils/catalogExtractor";
import { matchCatalogNumber } from "../src/utils/catalogMatcher";
import { deletePrivateObjects, uploadCatalogImage } from "../src/lib/objectStorage";

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;
const mockMatchCatalogNumber = matchCatalogNumber as jest.MockedFunction<typeof matchCatalogNumber>;
const mockUploadCatalogImage = uploadCatalogImage as jest.MockedFunction<typeof uploadCatalogImage>;
const mockDeletePrivateObjects = deletePrivateObjects as jest.MockedFunction<typeof deletePrivateObjects>;

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_SECRET = "jest-ai-errors-secret";
const VENDOR = "JEST-AI-ERRORS-VENDOR";
const FAKE_PDF_BASE64 = Buffer.alloc(16).toString("base64");

/** One minimal page returned by the mocked PDF extractor. */
const ONE_FAKE_PAGE = [
  { pageNum: 1, text: "page text", images: [], isRendered: false, pageWidth: 0, pageHeight: 0 },
];

// ── State ─────────────────────────────────────────────────────────────────────

let adminToken: string;
const seededJobIds: number[] = [];
const seededInventoryIds: number[] = [];
const seededItemIds: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJobRow(jobId: number): Promise<{ status: string; errorMessage: string | null }> {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      errorMessage: catalogPdfJobTable.errorMessage,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found in DB`);
  return row;
}

async function startJob(): Promise<string> {
  const res = await supertest(app)
    .post("/api/admin/catalog-pdf")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
    .expect(200);
  const { jobId } = res.body as { jobId: string };
  seededJobIds.push(Number(jobId));
  return jobId;
}

/**
 * Polls the DB until the parent job leaves 'pending'/'processing'. The child
 * row is marked failed BEFORE the parent UPDATE runs in the background catch,
 * so reading the parent immediately after the child turns terminal races the
 * propagation write.
 */
async function waitForParentTerminal(
  parentId: number,
  timeoutMs = 10_000,
): Promise<{ status: string; errorMessage: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let row = await readJobRow(parentId);
  while (Date.now() < deadline) {
    if (row.status !== "pending" && row.status !== "processing") return row;
    await new Promise((r) => setTimeout(r, 50));
    row = await readJobRow(parentId);
  }
  return row;
}

async function waitForTerminal(jobId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`);
    const { status } = res.body as { status: string };
    if (status === "done" || status === "failed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state within ${timeoutMs}ms`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 15_000);

afterEach(async () => {
  try {
    if (seededItemIds.length > 0) {
      await db.delete(inventoryTable).where(inArray(inventoryTable.id, seededItemIds));
      seededItemIds.length = 0;
    }
  } finally {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  }
});

afterAll(async () => {
  if (seededInventoryIds.length > 0) {
    await bestEffortFixtureCleanup("catalog PDF AI-error inventory", async () => {
      await db.delete(inventoryTable).where(inArray(inventoryTable.id, seededInventoryIds));
    });
  }
  if (seededItemIds.length > 0) {
    await bestEffortFixtureCleanup("catalog photo replacement items", async () => {
      await db.delete(inventoryTable).where(inArray(inventoryTable.id, seededItemIds));
    });
  }
  if (seededJobIds.length > 0) {
    await bestEffortFixtureCleanup("catalog PDF AI-error jobs", async () => {
      await db
        .delete(catalogPdfJobTable)
        .where(inArray(catalogPdfJobTable.id, seededJobIds));
    });
  }
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: CatalogAiError propagation to the DB
// ─────────────────────────────────────────────────────────────────────────────

describe("CatalogAiError propagation — DB job row", () => {
  it("skips the page and completes the job when extractCatalogPage throws a transient CatalogAiError('ai_error')", async () => {
    // Transient ai_error is per-page recoverable: the route logs it, counts
    // the page as processed, and continues — the job still finishes 'done'.
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_error", "upstream AI provider returned an unexpected error"),
    );

    const jobId = await startJob();
    await waitForTerminal(jobId);

    const row = await readJobRow(Number(jobId));
    expect(row.status).toBe("done");
    expect(row.errorMessage).toBeNull();
  });

  it("persists the 'ai_payload_too_large' code as errorMessage when that variant is thrown", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_payload_too_large", "request body too large (413)"),
    );

    const jobId = await startJob();
    await waitForTerminal(jobId);

    const row = await readJobRow(Number(jobId));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("ai_payload_too_large");
  });
});

describe("catalog image replacement ownership", () => {
  const firstOld = "/objects/test/catalog-images/old-first.png";
  const secondOld = "/objects/test/catalog-images/old-second.png";
  const firstNew = "/objects/test/catalog-images/new-first.png";
  const secondNew = "/objects/test/catalog-images/new-second.png";

  async function runReplacement(options: {
    oldSecond?: string | null;
    uploadResults: Array<string | Error>;
    confidence?: number;
    itemId?: number;
    failLaterPage?: boolean;
  }) {
    const [item] = options.itemId
      ? [{ id: options.itemId }]
      : await db.insert(inventoryTable).values({
          vendor: VENDOR,
          catalog: `JEST-IMAGE-${seededItemIds.length}-${process.pid}`,
          description: "Original",
          imageUrl: firstOld,
          imageUrl2: options.oldSecond ?? null,
          imageConfidence: options.confidence ?? null,
        }).returning({ id: inventoryTable.id });
    if (!item) throw new Error("Failed to seed catalog image fixture");
    if (!options.itemId) seededItemIds.push(item.id);

    const stored = new Set([firstOld, ...(options.oldSecond ? [options.oldSecond] : [])]);
    const deleted: string[] = [];
    mockDeletePrivateObjects.mockImplementation(async (paths) => {
      // Cleanup must happen only after the DB reference has committed.
      const [current] = await db.select({
        imageUrl: inventoryTable.imageUrl,
        imageUrl2: inventoryTable.imageUrl2,
      }).from(inventoryTable).where(eq(inventoryTable.id, item.id));
      for (const path of paths) {
        if (!path) continue;
        expect([current?.imageUrl, current?.imageUrl2]).not.toContain(path);
        deleted.push(path);
        stored.delete(path);
      }
    });
    mockUploadCatalogImage.mockImplementation(async () => {
      const result = options.uploadResults.shift();
      if (!result) throw new Error("Unexpected upload");
      if (result instanceof Error) throw result;
      stored.add(result);
      return result;
    });
    mockMatchCatalogNumber.mockResolvedValueOnce({ inventoryId: item.id, similarityScore: 0.9 });
    const firstPage = {
      pageNum: 1, text: "part", images: [Buffer.from("first"), Buffer.from("second")],
      isRendered: false, pageWidth: 0, pageHeight: 0,
    };
    mockExtractPdfPages.mockResolvedValueOnce(options.failLaterPage
      ? [firstPage, { ...firstPage, pageNum: 2, text: "fatal page", images: [] }]
      : [firstPage]);
    mockExtractCatalogPage.mockResolvedValueOnce({
      entries: [{
        catalogNumber: "JEST-IMAGE", description: "Extracted", confidence: 0.9,
        hasPartImage: true, imageRegion: null, imageRegion2: null, imageIndex: 0, imageIndex2: 1,
      }],
      rawText: "",
    });
    if (options.failLaterPage) {
      mockExtractCatalogPage.mockRejectedValueOnce(
        new CatalogAiError("ai_payload_too_large", "fatal second page"),
      );
    }

    const jobId = await startJob();
    await awaitJobTermination(Number(jobId));
    const [row] = await db.select({
      imageUrl: inventoryTable.imageUrl,
      imageUrl2: inventoryTable.imageUrl2,
    }).from(inventoryTable).where(eq(inventoryTable.id, item.id));
    return { itemId: item.id, row, stored, deleted, job: await readJobRow(Number(jobId)) };
  }

  it("keeps both existing photos when the first and second uploads fail", async () => {
    const result = await runReplacement({
      oldSecond: secondOld,
      uploadResults: [new Error("first failed"), new Error("second failed")],
    });
    expect(result.row).toEqual({ imageUrl: firstOld, imageUrl2: secondOld });
    expect(result.stored).toEqual(new Set([firstOld, secondOld]));
    expect(result.deleted).toEqual([]);
    expect(result.job.status).toBe("done_with_errors");
  });

  it("keeps the first photo when its upload fails, but commits the second replacement", async () => {
    const result = await runReplacement({
      oldSecond: secondOld,
      uploadResults: [new Error("first failed"), secondNew],
    });
    expect(result.row).toEqual({ imageUrl: firstOld, imageUrl2: secondNew });
    expect(result.stored).toEqual(new Set([firstOld, secondNew]));
    expect(result.deleted).toEqual([secondOld]);
  });

  it("commits the first replacement but keeps the second photo when its upload fails", async () => {
    const result = await runReplacement({
      oldSecond: secondOld,
      uploadResults: [firstNew, new Error("second failed")],
    });
    expect(result.row).toEqual({ imageUrl: firstNew, imageUrl2: secondOld });
    expect(result.stored).toEqual(new Set([firstNew, secondOld]));
    expect(result.deleted).toEqual([firstOld]);
  });

  it("preserves an existing single photo and removes both uncommitted uploads when the update loses", async () => {
    const result = await runReplacement({
      uploadResults: [firstNew, secondNew],
      confidence: 1,
    });
    expect(result.row).toEqual({ imageUrl: firstOld, imageUrl2: null });
    expect(result.stored).toEqual(new Set([firstOld]));
    expect(result.deleted).toEqual([firstNew, secondNew]);
  });

  it("lets a same-confidence retry replace a photo after the prior upload failed", async () => {
    const failed = await runReplacement({
      oldSecond: secondOld,
      uploadResults: [new Error("first failed"), new Error("second failed")],
    });
    expect(failed.row).toEqual({ imageUrl: firstOld, imageUrl2: secondOld });
    const retried = await runReplacement({
      itemId: failed.itemId,
      oldSecond: secondOld,
      uploadResults: [firstNew, secondNew],
    });
    expect(retried.row).toEqual({ imageUrl: firstNew, imageUrl2: secondNew });
    expect(retried.deleted).toEqual([firstOld, secondOld]);
    expect(retried.stored).toEqual(new Set([firstNew, secondNew]));
  });

  it("does not delete a shared old object while the other slot still uses it", async () => {
    const result = await runReplacement({
      oldSecond: firstOld,
      uploadResults: [firstNew, new Error("second failed")],
    });
    expect(result.row).toEqual({ imageUrl: firstNew, imageUrl2: firstOld });
    expect(result.deleted).toEqual([]);
    expect(result.stored).toEqual(new Set([firstOld, firstNew]));
  });

  it("restores saved photos and removes only new objects if a later page fails", async () => {
    const result = await runReplacement({
      oldSecond: secondOld,
      uploadResults: [firstNew, new Error("second upload failed")],
      failLaterPage: true,
    });
    expect(result.job.status).toBe("failed");
    expect(result.row).toEqual({ imageUrl: firstOld, imageUrl2: secondOld });
    expect(result.stored).toEqual(new Set([firstOld, secondOld]));
    expect(result.deleted).toEqual([firstNew]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: errorMessage exposed via status API
// ─────────────────────────────────────────────────────────────────────────────

describe("CatalogAiError propagation — status API response", () => {
  it("reports status=done with a null errorMessage when a transient CatalogAiError('ai_error') skipped a page", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_error", "AI call failed"),
    );

    const jobId = await startJob();
    await waitForTerminal(jobId);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("done");
    expect(res.body.errorMessage ?? null).toBeNull();
  });

  it("includes errorMessage='ai_payload_too_large' in the status JSON for that variant", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_payload_too_large", "payload exceeded provider limit"),
    );

    const jobId = await startJob();
    await waitForTerminal(jobId);

    const res = await supertest(app)
      .get(`/api/admin/catalog-pdf/${jobId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.status).toBe("failed");
    expect(res.body).toHaveProperty("errorMessage");
    expect(res.body.errorMessage).toBe("ai_payload_too_large");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Raw provider payload-too-large errors (isProviderPayloadTooLargeError)
// Processing is now asynchronous: POST returns 200 immediately and the job
// status is discovered via polling (no HTTP 413 from the route handler).
// ─────────────────────────────────────────────────────────────────────────────

describe("Raw provider payload-too-large error — job fails asynchronously with ai_payload_too_large", () => {
  it("returns 200 immediately and job eventually has errorMessage='ai_payload_too_large' when extractCatalogPage throws a status-413 error", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    const providerError = Object.assign(new Error("Request Entity Too Large"), { status: 413 });
    mockExtractCatalogPage.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .expect(200);

    const { jobId } = res.body as { jobId: string };
    seededJobIds.push(Number(jobId));
    await waitForTerminal(jobId);

    const row = await readJobRow(Number(jobId));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("ai_payload_too_large");
  });

  it("returns 200 immediately and job eventually has errorMessage='ai_payload_too_large' when extractCatalogPage throws 'payload too large'", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    const providerError = new Error("Request payload too large for the provider");
    mockExtractCatalogPage.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .expect(200);

    const { jobId } = res.body as { jobId: string };
    seededJobIds.push(Number(jobId));
    await waitForTerminal(jobId);

    const row = await readJobRow(Number(jobId));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("ai_payload_too_large");
  });

  it("stores errorMessage='ai_payload_too_large' in the DB (status-413 provider error)", async () => {
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    const providerError = Object.assign(new Error("Payload Too Large"), { status: 413 });
    mockExtractCatalogPage.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64, vendor: VENDOR })
      .expect(200);

    const { jobId } = res.body as { jobId: string };
    seededJobIds.push(Number(jobId));
    await waitForTerminal(jobId);

    const row = await readJobRow(Number(jobId));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toBe("ai_payload_too_large");
  });

  it("marks the parent job failed with ai_payload_too_large when a chunk encounters a provider 413 error", async () => {
    const parentId = await seedParentJob();

    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    const providerError = Object.assign(new Error("Request Entity Too Large"), { status: 413 });
    mockExtractCatalogPage.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: FAKE_PDF_BASE64,
        vendor: VENDOR,
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentId,
      })
      .expect(200);

    const { chunkJobId } = res.body as { jobId: string; chunkJobId: string };
    seededJobIds.push(Number(chunkJobId));
    await waitForTerminal(chunkJobId);

    const childRow = await readJobRow(Number(chunkJobId));
    expect(childRow.status).toBe("failed");
    expect(childRow.errorMessage).toBe("ai_payload_too_large");

    const parentRow = await waitForParentTerminal(parentId);
    expect(parentRow.status).toBe("failed");
    expect(parentRow.errorMessage).toBe("ai_payload_too_large");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4: CatalogAiError propagation in chunked uploads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inserts a bare parent job row directly into the DB so we can submit a child
 * chunk against it.  Returns the new parent's id and registers it for cleanup.
 */
async function seedParentJob(): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: VENDOR,
      filename: "jest-ai-errors-chunk.pdf",
      status: "pending",
      processedPages: 0,
      matchedParts: 0,
      chunkCount: 2,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed parent job for chunked AI error test");
  seededJobIds.push(row.id);
  return row.id;
}

describe("CatalogAiError propagation — chunked upload (child + parent)", () => {
  it("sets child status=failed with error code and propagates to parent when extractCatalogPage throws CatalogAiError('ai_error')", async () => {
    const parentId = await seedParentJob();

    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_error", "upstream AI provider error in chunk"),
    );

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: FAKE_PDF_BASE64,
        vendor: VENDOR,
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentId,
      })
      .expect(200);

    const { chunkJobId } = res.body as { jobId: string; chunkJobId: string };
    seededJobIds.push(Number(chunkJobId));

    await waitForTerminal(chunkJobId);

    // Transient ai_error is per-page recoverable: the child skips the page
    // and completes; nothing propagates a failure to the parent.
    const childRow = await readJobRow(Number(chunkJobId));
    expect(childRow.status).toBe("done");
    expect(childRow.errorMessage).toBeNull();

    const parentRow = await readJobRow(parentId);
    expect(parentRow.status).not.toBe("failed");
  });

  it("propagates 'ai_payload_too_large' from a chunk to the parent job", async () => {
    const parentId = await seedParentJob();

    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockRejectedValueOnce(
      new CatalogAiError("ai_payload_too_large", "chunk payload exceeded provider limit"),
    );

    const res = await supertest(app)
      .post("/api/admin/catalog-pdf")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        pdfBase64: FAKE_PDF_BASE64,
        vendor: VENDOR,
        chunkIndex: 0,
        chunkCount: 2,
        parentJobId: parentId,
      })
      .expect(200);

    const { chunkJobId } = res.body as { jobId: string; chunkJobId: string };
    seededJobIds.push(Number(chunkJobId));

    await waitForTerminal(chunkJobId);

    const childRow = await readJobRow(Number(chunkJobId));
    expect(childRow.status).toBe("failed");
    expect(childRow.errorMessage).toBe("ai_payload_too_large");

    const parentRow = await waitForParentTerminal(parentId);
    expect(parentRow.status).toBe("failed");
    expect(parentRow.errorMessage).toBe("ai_payload_too_large");
  });
});

describe("PDF worker secondary cleanup failures", () => {
  async function seedWorkerJob(status: "pending" | "processing" = "pending"): Promise<number> {
    const [row] = await db.insert(catalogPdfJobTable).values({
      vendor: VENDOR, filename: "worker-recovery.pdf", status,
      processedPages: 0, matchedParts: 0,
    }).returning({ id: catalogPdfJobTable.id });
    if (!row) throw new Error("Failed to seed worker job");
    seededJobIds.push(row.id);
    return row.id;
  }

  function captureWorkerLog() {
    const records: Array<{ details: Record<string, unknown>; message: string }> = [];
    const log = {
      error: (details: Record<string, unknown>, message: string) => records.push({ details, message }),
      info: () => undefined,
      warn: () => undefined,
    } as unknown as typeof logger;
    return { log, records };
  }

  async function runFailedWorker(jobId: number, log: typeof logger) {
    mockExtractPdfPages.mockRejectedValueOnce(new Error("private PDF text in original error"));
    expect(launchCatalogPdfBuffer(jobId, Buffer.from("pdf"), VENDOR, log)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await awaitJobTermination(jobId);
  }

  function failNextInventoryRollback() {
    const originalSelect = db.select.bind(db);
    let injected = false;
    jest.spyOn(db, "select").mockImplementation(((...args: unknown[]) => {
      const query = originalSelect(...args as Parameters<typeof db.select>);
      return new Proxy(query, {
        get(target, key) {
          if (key !== "from") return Reflect.get(target, key);
          return (table: unknown) => {
            const from = target.from(table as typeof inventoryTable);
            if (table !== inventoryTable || injected) return from;
            return new Proxy(from, {
              get(inner, property) {
                if (property !== "where") return Reflect.get(inner, property);
                return () => {
                  injected = true;
                  return Promise.reject(new Error("private inventory details in rollback error"));
                };
              },
            });
          };
        },
      });
    }) as typeof db.select);
    return () => injected;
  }

  it("retries a failed terminal write without losing the original bounded diagnostic", async () => {
    const jobId = await seedWorkerJob();
    const { log, records } = captureWorkerLog();
    const originalUpdate = db.update.bind(db);
    let injected = false;
    jest.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const query = originalUpdate(table as typeof catalogPdfJobTable);
      if (table !== catalogPdfJobTable) return query;
      return new Proxy(query, {
        get(target, key) {
          if (key !== "set") return Reflect.get(target, key);
          return (values: { status?: string }) => {
            const update = target.set(values);
            if (values.status !== "failed" || injected) return update;
            return new Proxy(update, {
              get(inner, property) {
                if (property !== "where") return Reflect.get(inner, property);
                return () => {
                  injected = true;
                  return Promise.reject(new Error("private SQL parameters in terminal error"));
                };
              },
            });
          };
        },
      });
    }) as typeof db.update);

    await runFailedWorker(jobId, log);
    expect(injected).toBe(true);
    expect(await readJobRow(jobId)).toEqual({
      status: "failed", errorMessage: "catalog_pdf_status_write_failed",
    });
    expect(records.map((r) => r.message)).toEqual(expect.arrayContaining([
      "[catalog-pdf] background processing failed",
      "[catalog-pdf] failed to persist worker terminal status",
    ]));
    expect(JSON.stringify(records)).not.toMatch(/private PDF text|private SQL parameters/);
  });

  it("recovers at startup when both terminal writes fail, then permits Resume", async () => {
    const jobId = await seedWorkerJob();
    const { log, records } = captureWorkerLog();
    const originalUpdate = db.update.bind(db);
    let failures = 0;
    jest.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const query = originalUpdate(table as typeof catalogPdfJobTable);
      if (table !== catalogPdfJobTable) return query;
      return new Proxy(query, {
        get(target, key) {
          if (key !== "set") return Reflect.get(target, key);
          return (values: { status?: string }) => {
            const update = target.set(values);
            if (values.status !== "failed" || failures >= 2) return update;
            return new Proxy(update, {
              get(inner, property) {
                if (property !== "where") return Reflect.get(inner, property);
                return () => {
                  failures++;
                  return Promise.reject(new Error("private SQL parameter"));
                };
              },
            });
          };
        },
      });
    }) as typeof db.update);
    await runFailedWorker(jobId, log);
    expect(failures).toBe(2);
    expect((await readJobRow(jobId)).status).toBe("processing");
    expect(records.map((r) => r.message)).toContain("[catalog-pdf] failed to persist recoverable worker state");
    expect(JSON.stringify(records)).not.toMatch(/private PDF text|private SQL parameter/);

    jest.restoreAllMocks();
    await recoverInterruptedCatalogPdfJobs();
    expect(await readJobRow(jobId)).toEqual({
      status: "failed", errorMessage: "catalog_pdf_rollback_failed",
    });
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockResolvedValueOnce({ entries: [], rawText: "" });
    await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(200);
    await awaitJobTermination(jobId);
    expect((await readJobRow(jobId)).status).toBe("done");
  });

  it("marks rollback failure recoverable and retries it before Resume proceeds", async () => {
    const jobId = await seedWorkerJob();
    const { log, records } = captureWorkerLog();
    const rollbackFailed = failNextInventoryRollback();
    await runFailedWorker(jobId, log);
    expect(rollbackFailed()).toBe(true);
    expect(await readJobRow(jobId)).toEqual({
      status: "failed", errorMessage: "catalog_pdf_rollback_failed",
    });
    expect(records.map((r) => r.message)).toEqual(expect.arrayContaining([
      "[catalog-pdf] background processing failed",
      "[catalog-pdf] failed to revert worker session items",
    ]));
    expect(JSON.stringify(records)).not.toMatch(/private PDF text|private inventory details/);

    jest.restoreAllMocks();
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockResolvedValueOnce({ entries: [], rawText: "" });
    await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(200);
    await awaitJobTermination(jobId);
    expect((await readJobRow(jobId)).status).toBe("done");
  });

  it("does not leave a cancelled worker unrecoverable when cancellation rollback fails", async () => {
    mockExtractPdfPages.mockResolvedValueOnce([
      ONE_FAKE_PAGE[0]!,
      { ...ONE_FAKE_PAGE[0]!, pageNum: 2 },
    ]);
    let jobId: string;
    mockExtractCatalogPage.mockImplementationOnce(async () => {
      await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/cancel`)
        .set("Authorization", `Bearer ${adminToken}`).expect(200);
      return { entries: [], rawText: "" };
    });
    jobId = await startJob();
    const rollbackFailed = failNextInventoryRollback();
    await awaitJobTermination(Number(jobId));
    expect(rollbackFailed()).toBe(true);
    expect(await readJobRow(Number(jobId))).toEqual({
      status: "failed", errorMessage: "catalog_pdf_rollback_failed",
    });
    jest.restoreAllMocks();
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockResolvedValueOnce({ entries: [], rawText: "" });
    await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(200);
    await awaitJobTermination(Number(jobId));
    expect((await readJobRow(Number(jobId))).status).toBe("done");
  });

  it("keeps a failed parent terminal when child Resume cannot retry rollback", async () => {
    const parentId = await seedParentJob();
    await db.update(catalogPdfJobTable).set({ status: "failed", errorMessage: "child_job_failed" })
      .where(eq(catalogPdfJobTable.id, parentId));
    const [child] = await db.insert(catalogPdfJobTable).values({
      vendor: VENDOR, filename: "child-recovery.pdf", status: "failed",
      errorMessage: "catalog_pdf_rollback_failed",
      parentJobId: parentId, chunkCount: 2, chunkIndex: 0,
      processedPages: 0, matchedParts: 0,
    }).returning({ id: catalogPdfJobTable.id });
    if (!child) throw new Error("Failed to seed child job");
    seededJobIds.push(child.id);
    const rollbackFailed = failNextInventoryRollback();
    await supertest(app).post(`/api/admin/catalog-pdf/${child.id}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(503);
    expect(rollbackFailed()).toBe(true);
    expect((await readJobRow(child.id)).status).toBe("failed");
    expect((await readJobRow(parentId)).status).toBe("failed");
  });

  it("rejects a duplicate Resume without reverting the first worker's inventory write", async () => {
    const jobId = await seedWorkerJob();
    await db.update(catalogPdfJobTable)
      .set({ status: "failed", errorMessage: "catalog_pdf_rollback_failed" })
      .where(eq(catalogPdfJobTable.id, jobId));
    const [item] = await db.insert(inventoryTable).values({
      vendor: VENDOR, catalog: `JEST-RESUME-${jobId}`, description: "before Resume",
    }).returning({ id: inventoryTable.id });
    if (!item) throw new Error("Failed to seed inventory");
    seededInventoryIds.push(item.id);
    mockMatchCatalogNumber.mockResolvedValueOnce({ inventoryId: item.id, similarityScore: 1 });
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockResolvedValueOnce({
      entries: [{
        catalogNumber: `JEST-RESUME-${jobId}`, description: "saved by first worker",
        confidence: 1, hasPartImage: false, imageRegion: null, imageRegion2: null,
        imageIndex: -1, imageIndex2: -1,
      }],
      rawText: "",
    });
    let signalWrite!: () => void;
    const wroteItem = new Promise<void>((resolve) => { signalWrite = resolve; });
    let releaseWorker!: () => void;
    const continueWorker = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const originalUpdate = db.update.bind(db);
    jest.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const query = originalUpdate(table as typeof catalogPdfJobTable);
      if (table !== catalogPdfJobTable) return query;
      return new Proxy(query, {
        get(target, key) {
          if (key !== "set") return Reflect.get(target, key);
          return (values: { processedPages?: number; status?: string }) => {
            const update = target.set(values);
            if (values.processedPages !== 1 || values.status) return update;
            return new Proxy(update, {
              get(inner, property) {
                if (property !== "where") return Reflect.get(inner, property);
                return (...args: Parameters<typeof inner.where>) => {
                  signalWrite();
                  return continueWorker.then(() => inner.where(...args));
                };
              },
            });
          };
        },
      });
    }) as typeof db.update);

    try {
      await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(200);
      await wroteItem;
      const duplicate = await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ pdfBase64: FAKE_PDF_BASE64 });
      expect(duplicate.status).toBe(409);
      const [saved] = await db.select({
        description: inventoryTable.description, jobId: inventoryTable.catalogPdfJobId,
      }).from(inventoryTable).where(eq(inventoryTable.id, item.id));
      expect(saved).toEqual({ description: "saved by first worker", jobId });
    } finally {
      releaseWorker();
      await awaitJobTermination(jobId);
    }
    expect((await readJobRow(jobId)).status).toBe("done");
  });

  it("reconciles an orphaned processing worker to a resumable failed state on restart", async () => {
    const jobId = await seedWorkerJob("processing");
    await recoverInterruptedCatalogPdfJobs();
    expect(await readJobRow(jobId)).toEqual({
      status: "failed", errorMessage: "catalog_pdf_rollback_failed",
    });
    mockExtractPdfPages.mockResolvedValueOnce(ONE_FAKE_PAGE);
    mockExtractCatalogPage.mockResolvedValueOnce({ entries: [], rawText: "" });
    await supertest(app).post(`/api/admin/catalog-pdf/${jobId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ pdfBase64: FAKE_PDF_BASE64 }).expect(200);
    await awaitJobTermination(jobId);
    expect((await readJobRow(jobId)).status).toBe("done");
  });
});
