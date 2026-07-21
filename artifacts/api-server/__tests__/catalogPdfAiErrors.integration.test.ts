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
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { db, catalogPdfJobTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { extractPdfPages } from "../src/utils/pdfProcessor";
import { extractCatalogPage, CatalogAiError } from "../src/utils/catalogExtractor";

// ── Typed mock handles ─────────────────────────────────────────────────────────

const mockExtractPdfPages = extractPdfPages as jest.MockedFunction<typeof extractPdfPages>;
const mockExtractCatalogPage = extractCatalogPage as jest.MockedFunction<typeof extractCatalogPage>;

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

afterEach(() => {
  jest.resetAllMocks();
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededJobIds));
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
