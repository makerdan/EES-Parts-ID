/**
 * Cross-admin ownership regression coverage for catalog PDF jobs.
 *
 * Every request below is made by an approved administrator, but only the
 * administrator recorded on the job may read or mutate it. Parent and child
 * chunk jobs are exercised together because the review and lifecycle routes
 * intentionally aggregate them.
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

import supertest from "supertest";
import { eq, inArray } from "drizzle-orm";

import {
  catalogPdfJobTable,
  db,
  inventoryTable,
} from "@workspace/db";
import app from "../src/app";
import {
  cleanupTestUser,
  seedTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";

const OWNER_A = workerQualifiedUserId("catalog-pdf-owner-a");
const OWNER_B = workerQualifiedUserId("catalog-pdf-owner-b");
const VENDOR = "JEST-CATALOG-OWNERSHIP";

const jobIds: number[] = [];
const inventoryIds: number[] = [];

function auth(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${userId}` };
}

async function seedJob(options: {
  ownerClerkUserId: string;
  status: string;
  parentJobId?: number;
  chunkIndex?: number;
  chunkCount?: number;
}): Promise<number> {
  const [row] = await db
    .insert(catalogPdfJobTable)
    .values({
      ownerClerkUserId: options.ownerClerkUserId,
      vendor: VENDOR,
      filename: `${options.ownerClerkUserId}.pdf`,
      status: options.status,
      processedPages: 0,
      matchedParts: 0,
      ...(options.parentJobId === undefined
        ? { ...(options.chunkCount === undefined ? {} : { chunkCount: options.chunkCount }) }
        : {
            parentJobId: options.parentJobId,
            chunkIndex: options.chunkIndex ?? 0,
            chunkCount: options.chunkCount ?? 2,
          }),
    })
    .returning({ id: catalogPdfJobTable.id });
  if (!row) throw new Error("Failed to seed catalog PDF job");
  jobIds.push(row.id);
  return row.id;
}

async function seedReviewItem(jobId: number, catalog: string): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: VENDOR,
      catalog,
      description: "Updated description",
      previousDescription: "Original description",
      imageSource: "pdf_extraction",
      imageConfidence: 0.9,
      catalogPdfJobId: jobId,
      binLocations: [],
      aiKeywords: [],
    })
    .returning({ id: inventoryTable.id });
  if (!row) throw new Error("Failed to seed catalog PDF review item");
  inventoryIds.push(row.id);
  return row.id;
}

async function readJob(jobId: number) {
  const [row] = await db
    .select({
      status: catalogPdfJobTable.status,
      dismissed: catalogPdfJobTable.dismissed,
    })
    .from(catalogPdfJobTable)
    .where(eq(catalogPdfJobTable.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} not found`);
  return row;
}

async function readReview(itemId: number) {
  const [row] = await db
    .select({
      description: inventoryTable.description,
      imageSource: inventoryTable.imageSource,
      catalogPdfJobId: inventoryTable.catalogPdfJobId,
    })
    .from(inventoryTable)
    .where(eq(inventoryTable.id, itemId))
    .limit(1);
  if (!row) throw new Error(`Inventory item ${itemId} not found`);
  return row;
}

beforeAll(async () => {
  await Promise.all([
    seedTestUser({ clerkUserId: OWNER_A, status: "approved", role: "admin" }),
    seedTestUser({ clerkUserId: OWNER_B, status: "approved", role: "admin" }),
  ]);
}, 15_000);

afterAll(async () => {
  if (inventoryIds.length > 0) {
    await db.delete(inventoryTable).where(inArray(inventoryTable.id, inventoryIds));
  }
  if (jobIds.length > 0) {
    await db.delete(catalogPdfJobTable).where(inArray(catalogPdfJobTable.id, jobIds));
  }
  await Promise.all([cleanupTestUser(OWNER_A), cleanupTestUser(OWNER_B)]);
}, 15_000);

it("keeps every catalog lifecycle and review path inside the caller's job tree", async () => {
  const parentA = await seedJob({ ownerClerkUserId: OWNER_A, status: "processing", chunkCount: 2 });
  const childA = await seedJob({
    ownerClerkUserId: OWNER_A,
    status: "processing",
    parentJobId: parentA,
    chunkIndex: 0,
    chunkCount: 2,
  });
  const failedA = await seedJob({ ownerClerkUserId: OWNER_A, status: "failed" });
  const failedB = await seedJob({ ownerClerkUserId: OWNER_B, status: "failed" });
  const parentB = await seedJob({ ownerClerkUserId: OWNER_B, status: "processing", chunkCount: 2 });
  const childB = await seedJob({
    ownerClerkUserId: OWNER_B,
    status: "processing",
    parentJobId: parentB,
    chunkIndex: 0,
    chunkCount: 2,
  });
  const itemA = await seedReviewItem(childA, "OWNER-A-ITEM");
  const itemB = await seedReviewItem(childB, "OWNER-B-ITEM");

  await supertest(app)
    .get(`/api/admin/catalog-pdf/${parentA}/status`)
    .set(auth(OWNER_A))
    .expect(200);
  await supertest(app)
    .get(`/api/admin/catalog-pdf/${parentA}/status`)
    .set(auth(OWNER_B))
    .expect(404);
  await supertest(app)
    .get(`/api/admin/catalog-pdf/${childA}/status`)
    .set(auth(OWNER_B))
    .expect(404);

  await supertest(app)
    .post(`/api/admin/catalog-pdf/${parentA}/cancel`)
    .set(auth(OWNER_B))
    .expect(404);
  expect(await readJob(parentA)).toMatchObject({ status: "processing" });
  expect(await readJob(childA)).toMatchObject({ status: "processing" });

  await supertest(app)
    .post(`/api/admin/catalog-pdf/${failedA}/resume`)
    .set(auth(OWNER_B))
    .send({ pdfBase64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64") })
    .expect(404);
  expect(await readJob(failedA)).toMatchObject({ status: "failed" });

  const failedForA = await supertest(app)
    .get("/api/admin/catalog-pdf/failed-jobs")
    .set(auth(OWNER_A))
    .expect(200);
  expect(failedForA.body.jobs.map((job: { id: number }) => job.id)).toEqual(
    expect.arrayContaining([failedA]),
  );
  expect(failedForA.body.jobs.map((job: { id: number }) => job.id)).not.toContain(failedB);

  const failedForB = await supertest(app)
    .get("/api/admin/catalog-pdf/failed-jobs")
    .set(auth(OWNER_B))
    .expect(200);
  expect(failedForB.body.jobs.map((job: { id: number }) => job.id)).toEqual(
    expect.arrayContaining([failedB]),
  );
  expect(failedForB.body.jobs.map((job: { id: number }) => job.id)).not.toContain(failedA);

  await supertest(app)
    .post(`/api/admin/catalog-pdf/${failedA}/dismiss`)
    .set(auth(OWNER_B))
    .expect(404);
  expect(await readJob(failedA)).toMatchObject({ dismissed: false });

  const reviewsForA = await supertest(app)
    .get("/api/admin/catalog-pdf/reviews")
    .set(auth(OWNER_A))
    .expect(200);
  expect(reviewsForA.body.items.map((item: { id: number }) => item.id)).toContain(itemA);
  expect(reviewsForA.body.items.map((item: { id: number }) => item.id)).not.toContain(itemB);

  await supertest(app)
    .get(`/api/admin/catalog-pdf/reviews?jobId=${parentA}`)
    .set(auth(OWNER_B))
    .expect(404);

  const reviewsForB = await supertest(app)
    .get(`/api/admin/catalog-pdf/reviews?jobId=${parentB}`)
    .set(auth(OWNER_B))
    .expect(200);
  expect(reviewsForB.body.items.map((item: { id: number }) => item.id)).toContain(itemB);
  expect(reviewsForB.body.items.map((item: { id: number }) => item.id)).not.toContain(itemA);

  await supertest(app)
    .post(`/api/admin/catalog-pdf/reviews/${itemA}/revert`)
    .set(auth(OWNER_B))
    .send({ jobId: parentA })
    .expect(404);
  expect(await readReview(itemA)).toMatchObject({
    description: "Updated description",
    imageSource: "pdf_extraction",
    catalogPdfJobId: childA,
  });

  await supertest(app)
    .post(`/api/admin/catalog-pdf/reviews/${itemA}/revert`)
    .set(auth(OWNER_B))
    .expect(404);
  expect(await readReview(itemA)).toMatchObject({
    description: "Updated description",
    imageSource: "pdf_extraction",
    catalogPdfJobId: childA,
  });

  await supertest(app)
    .post(`/api/admin/catalog-pdf/reviews/${itemA}/revert`)
    .set(auth(OWNER_A))
    .send({ jobId: parentA })
    .expect(200);
  expect(await readReview(itemA)).toMatchObject({
    description: "Original description",
    imageSource: null,
    catalogPdfJobId: null,
  });
});