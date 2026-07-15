/**
 * Integration tests for the failed-jobs API endpoints:
 *   GET  /api/admin/catalog-pdf/failed-jobs
 *   POST /api/admin/catalog-pdf/:jobId/dismiss
 *
 * Seeds catalog_pdf_job rows directly in the DB to verify filtering,
 * field shapes, ordering, and dismiss behaviour.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { db, catalogPdfJobTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ── Setup / teardown ──────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-failed-jobs-secret";
let adminToken: string;
const seededIds: number[] = [];

interface SeedOptions {
  status: string;
  errorMessage?: string | null;
  processedPages?: number;
  totalPages?: number | null;
  matchedParts?: number;
  dismissed?: boolean;
  vendor?: string;
}

async function seedJob(opts: SeedOptions): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      vendor: opts.vendor ?? "JEST-VENDOR",
      filename: "jest-test.pdf",
      status: opts.status,
      processedPages: opts.processedPages ?? 0,
      matchedParts: opts.matchedParts ?? 0,
      errorMessage: opts.errorMessage ?? null,
      totalPages: opts.totalPages ?? null,
      dismissed: opts.dismissed ?? false,
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed job");
  seededIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
}, 15_000);

afterAll(async () => {
  if (seededIds.length > 0) {
    await db
      .delete(catalogPdfJobTable)
      .where(inArray(catalogPdfJobTable.id, seededIds));
  }
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/catalog-pdf/failed-jobs — auth
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/catalog-pdf/failed-jobs — auth", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 when an invalid (unknown) token is provided", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", "Bearer invalid-token-xyz")
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/catalog-pdf/failed-jobs — response shape and filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/catalog-pdf/failed-jobs — response shape and filtering", () => {
  it("returns an object with a 'jobs' array", async () => {
    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("jobs");
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it("includes a failed job with all required fields", async () => {
    const id = await seedJob({
      status: "failed",
      errorMessage: "PDF could not be parsed: unexpected EOF",
      processedPages: 2,
      totalPages: 8,
      matchedParts: 1,
    });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const job = (res.body.jobs as Array<{ id: number }>).find((j) => j.id === id);
    expect(job).toBeDefined();
    expect(job).toMatchObject({
      id,
      vendor: "JEST-VENDOR",
      filename: "jest-test.pdf",
      status: "failed",
      errorMessage: "PDF could not be parsed: unexpected EOF",
      processedPages: 2,
      totalPages: 8,
      matchedParts: 1,
    });
    expect(job).toHaveProperty("createdAt");
    expect(job).toHaveProperty("finishedAt");
  });

  it("does not include jobs with status 'pending'", async () => {
    const pendingId = await seedJob({ status: "pending" });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const ids = (res.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(ids).not.toContain(pendingId);
  });

  it("does not include jobs with status 'processing'", async () => {
    const processingId = await seedJob({ status: "processing" });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const ids = (res.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(ids).not.toContain(processingId);
  });

  it("does not include jobs with status 'done'", async () => {
    const doneId = await seedJob({ status: "done", processedPages: 5, totalPages: 5 });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const ids = (res.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(ids).not.toContain(doneId);
  });

  it("does not include failed jobs that have been dismissed", async () => {
    const dismissedId = await seedJob({
      status: "failed",
      errorMessage: "Already dismissed",
      dismissed: true,
    });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const ids = (res.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(ids).not.toContain(dismissedId);
  });

  it("handles null errorMessage by including it as null", async () => {
    const id = await seedJob({ status: "failed", errorMessage: null });

    const res = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    const job = (res.body.jobs as Array<{ id: number; errorMessage: string | null }>).find(
      (j) => j.id === id,
    );
    expect(job).toBeDefined();
    expect(job!.errorMessage).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/catalog-pdf/:jobId/dismiss
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/catalog-pdf/:jobId/dismiss", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf/1/dismiss")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric job ID", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf/not-a-number/dismiss")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("dismisses a failed job so it no longer appears in the failed-jobs list", async () => {
    const id = await seedJob({
      status: "failed",
      errorMessage: "Connection timeout",
    });

    // Verify the job is in the list before dismissing
    const before = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const idsBefore = (before.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(idsBefore).toContain(id);

    // Dismiss it
    const dismiss = await supertest(app)
      .post(`/api/admin/catalog-pdf/${id}/dismiss`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(dismiss.body).toMatchObject({ ok: true });

    // Verify it is gone from the list
    const after = await supertest(app)
      .get("/api/admin/catalog-pdf/failed-jobs")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    const idsAfter = (after.body.jobs as Array<{ id: number }>).map((j) => j.id);
    expect(idsAfter).not.toContain(id);
  });

  it("returns 404 when the job ID does not exist", async () => {
    const res = await supertest(app)
      .post("/api/admin/catalog-pdf/999999999/dismiss")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 when the job exists but is not in failed state", async () => {
    const id = await seedJob({ status: "done", processedPages: 5, totalPages: 5 });

    const res = await supertest(app)
      .post(`/api/admin/catalog-pdf/${id}/dismiss`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(404);

    expect(res.body).toHaveProperty("error");
  });
});
