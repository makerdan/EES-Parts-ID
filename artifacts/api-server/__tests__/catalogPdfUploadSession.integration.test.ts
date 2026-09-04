/**
 * Adversarial contract coverage for the durable catalog PDF upload boundary.
 * Storage is an in-memory private namespace here; the production adapter is
 * exercised by its own integration and deployment checks.
 */
const staged = new Map<string, Buffer>();

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

jest.mock("../src/lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../src/lib/poeBot")>("../src/lib/poeBot");
  return {
    ...actual,
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: jest.fn() } } }, "test-model"),
    ),
  };
});

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
  writeCatalogPdfPart: jest.fn(async (sessionId: string, index: number, bytes: Buffer) => {
    const key = `${sessionId}/${index}`;
    if (staged.has(key)) throw new Error("already exists");
    staged.set(key, Buffer.from(bytes));
    return `/private/${key}`;
  }),
  readCatalogPdfPart: jest.fn(async (sessionId: string, index: number) => {
    const bytes = staged.get(`${sessionId}/${index}`);
    if (!bytes) throw new Error("missing staged object");
    return bytes;
  }),
  deleteCatalogPdfPart: jest.fn(async (sessionId: string, index: number) => {
    staged.delete(`${sessionId}/${index}`);
  }),
}));

jest.mock("../src/utils/pdfProcessor", () => ({
  extractPdfPages: jest.fn(async () => []),
  validatePdf: jest.fn(),
}));

import { createHash } from "node:crypto";
import supertest from "supertest";
import { eq, inArray } from "drizzle-orm";

import app from "../src/app";
import { awaitJobTermination } from "../src/routes/catalogPdf";
import { signAdminToken } from "./helpers/adminAuth";
import {
  catalogPdfUploadPartTable,
  catalogPdfUploadSessionTable,
  db,
} from "@workspace/db";

const adminToken = signAdminToken();
const auth = { Authorization: `Bearer ${adminToken}` };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("durable catalog PDF upload session", () => {
  const sessionIds: string[] = [];

  afterEach(async () => {
    if (sessionIds.length > 0) {
      await db.delete(catalogPdfUploadPartTable)
        .where(inArray(catalogPdfUploadPartTable.sessionId, sessionIds));
      await db.delete(catalogPdfUploadSessionTable)
        .where(inArray(catalogPdfUploadSessionTable.id, sessionIds));
    }
    staged.clear();
    sessionIds.length = 0;
  });

  it("validates ranges/checksums, converges identical retries, isolates owners, and completes once", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF");
    const start = await supertest(app)
      .post("/api/admin/catalog-pdf/upload-sessions")
      .set(auth)
      .send({
        vendor: "EATON",
        filename: "catalog.pdf",
        totalBytes: pdf.length,
        partSize: 4,
        fileSha256: sha256(pdf),
      })
      .expect(201);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);
    expect(start.body).toMatchObject({
      status: "open",
      totalBytes: pdf.length,
      partSize: 4,
      partCount: Math.ceil(pdf.length / 4),
    });

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(pdf.subarray(0, 4))
      .expect(201);

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(pdf.subarray(0, 4))
      .expect(200);

    await supertest(app)
      .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/0`)
      .set(auth)
      .set("Content-Type", "application/octet-stream")
      .set("Content-Range", `bytes 0-3/${pdf.length}`)
      .set("X-Part-SHA256", sha256(pdf.subarray(0, 4)))
      .send(Buffer.from("nope"))
      .expect((response) => {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("CHECKSUM_MISMATCH");
      });

    await db.update(catalogPdfUploadSessionTable)
      .set({ ownerClerkUserId: "different-owner" })
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));
    await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(404);
    await db.update(catalogPdfUploadSessionTable)
      .set({ ownerClerkUserId: "jest-admin-user" })
      .where(eq(catalogPdfUploadSessionTable.id, sessionId));

    for (let index = 1; index < Math.ceil(pdf.length / 4); index++) {
      const offset = index * 4;
      const part = pdf.subarray(offset, Math.min(pdf.length, offset + 4));
      await supertest(app)
        .put(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/parts/${index}`)
        .set(auth)
        .set("Content-Type", "application/octet-stream")
        .set("Content-Range", `bytes ${offset}-${offset + part.length - 1}/${pdf.length}`)
        .set("X-Part-SHA256", sha256(part))
        .send(part)
        .expect(201);
    }

    const firstComplete = await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(firstComplete.body.jobId).toEqual(expect.any(String));
    await awaitJobTermination(Number(firstComplete.body.jobId));

    const secondComplete = await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(secondComplete.body.jobId).toBe(firstComplete.body.jobId);

    const status = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(status.body).toMatchObject({
      status: "completed",
      uploadedBytes: pdf.length,
      uploadedParts: Math.ceil(pdf.length / 4),
      processingJobId: firstComplete.body.jobId,
      missingPartIndices: [],
    });
  });

  it("does not finalize an incomplete manifest and cancels staged data repeatably", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF");
    const start = await supertest(app)
      .post("/api/admin/catalog-pdf/upload-sessions")
      .set(auth)
      .send({ vendor: "EATON", totalBytes: pdf.length, partSize: 4 })
      .expect(201);
    const sessionId = start.body.sessionId as string;
    sessionIds.push(sessionId);

    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/complete`)
      .set(auth)
      .send({})
      .expect((response) => {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe("MISSING_PARTS");
      });

    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(200);
    await supertest(app)
      .post(`/api/admin/catalog-pdf/upload-sessions/${sessionId}/cancel`)
      .set(auth)
      .expect(200);

    const cancelled = await supertest(app)
      .get(`/api/admin/catalog-pdf/upload-sessions/${sessionId}`)
      .set(auth)
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
  });
});