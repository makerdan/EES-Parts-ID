/**
 * Integration tests for authenticated, per-user history storage.
 *
 * The Clerk test middleware maps `Authorization: Bearer <id>` to that
 * authenticated user. History ownership must always come from that identity,
 * never from a client-supplied account ID.
 */
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

import { db, userHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import supertest from "supertest";

import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { cleanupTestUser, seedTestUser } from "./helpers/testDb";

const TEST_INSTANCE = `${process.pid}-${process.env.JEST_WORKER_ID ?? "single"}`;
const USER_PREFIX = `jest-history-${TEST_INSTANCE}-`;
const seededUserIds = new Set<string>();

async function seedApprovedUser(clerkUserId: string): Promise<void> {
  seededUserIds.add(clerkUserId);
  await seedTestUser({ clerkUserId, status: "approved", role: "user" });
}

async function cleanupUsers(): Promise<void> {
  const userIds = [...seededUserIds];
  seededUserIds.clear();
  await Promise.all(userIds.map(cleanupTestUser));
}

function authenticated(userId: string) {
  const authorization = `Bearer ${userId}`;
  return {
    get: (path: string) => supertest(app).get(path).set("Authorization", authorization),
    patch: (path: string) => supertest(app).patch(path).set("Authorization", authorization),
    delete: (path: string) => supertest(app).delete(path).set("Authorization", authorization),
  };
}

const emptyHistory = {
  queryHistory: [],
  viewedHistory: [],
  scanHistory: [],
};

function viewedEntry(id: number) {
  return {
    id,
    catalog: `CAT-${id}`,
    name: `Part ${id}`,
    vendor: "Example",
    timestamp: new Date().toISOString(),
  };
}

function scanEntry(index: number) {
  return {
    barcode: `BC-${index}`,
    found: true,
    itemId: index + 1,
    catalog: `CAT-${index}`,
    vendor: "Example",
    timestamp: new Date().toISOString(),
  };
}

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = ADMIN_TEST_USER_ID;
  delete process.env.TEST_DEFAULT_AUTH_USER;
});

afterAll(async () => {
  delete process.env.ADMIN_CLERK_USER_ID;
  await cleanupUsers();
}, 15_000);

describe("GET and PATCH /api/user/history", () => {
  it("requires an authenticated, approved user", async () => {
    await supertest(app).get("/api/user/history").expect(401);
    await supertest(app).patch("/api/user/history").send({ queryHistory: [] }).expect(401);
  });

  it("returns and updates only the history owned by the authenticated Clerk user", async () => {
    const userA = `${USER_PREFIX}a`;
    const userB = `${USER_PREFIX}b`;
    await seedApprovedUser(userA);
    await seedApprovedUser(userB);

    await authenticated(userA)
      .patch("/api/user/history")
      .send({
        queryHistory: ["A private search"],
        viewedHistory: [viewedEntry(1)],
        scanHistory: [scanEntry(0)],
      })
      .expect(200);
    await authenticated(userB)
      .patch("/api/user/history")
      .send({ queryHistory: ["B private search"] })
      .expect(200);

    const responseA = await authenticated(userA).get("/api/user/history").expect(200);
    const responseB = await authenticated(userB).get("/api/user/history").expect(200);
    expect(responseA.body).toEqual({
      queryHistory: ["A private search"],
      viewedHistory: [expect.objectContaining({ id: 1 })],
      scanHistory: [expect.objectContaining({ barcode: "BC-0" })],
    });
    expect(responseB.body).toEqual({
      queryHistory: ["B private search"],
      viewedHistory: [],
      scanHistory: [],
    });

    await authenticated(userA)
      .patch("/api/user/history")
      .send({ clerkUserId: userB, queryHistory: ["overwrite attempt"] })
      .expect(400);
    const afterRejectedOwner = await authenticated(userA).get("/api/user/history").expect(200);
    expect(afterRejectedOwner.body.queryHistory).toEqual(["A private search"]);
    const afterRejectedTarget = await authenticated(userB).get("/api/user/history").expect(200);
    expect(afterRejectedTarget.body.queryHistory).toEqual(["B private search"]);
  });

  it("enforces the 10/10/50 entry limits and rejects malformed shapes without overwriting history", async () => {
    const userId = `${USER_PREFIX}limits`;
    await seedApprovedUser(userId);

    const atLimit = {
      queryHistory: Array.from({ length: 10 }, (_, index) => `query-${index}`),
      viewedHistory: Array.from({ length: 10 }, (_, index) => viewedEntry(index + 1)),
      scanHistory: Array.from({ length: 50 }, (_, index) => scanEntry(index)),
    };
    await authenticated(userId).patch("/api/user/history").send(atLimit).expect(200);

    await authenticated(userId)
      .patch("/api/user/history")
      .send({ queryHistory: [...atLimit.queryHistory, "too many"] })
      .expect(400);
    await authenticated(userId)
      .patch("/api/user/history")
      .send({ viewedHistory: [...atLimit.viewedHistory, viewedEntry(11)] })
      .expect(400);
    await authenticated(userId)
      .patch("/api/user/history")
      .send({ scanHistory: [...atLimit.scanHistory, scanEntry(50)] })
      .expect(400);
    await authenticated(userId)
      .patch("/api/user/history")
      .send({ scanHistory: [{ barcode: "BC-BAD", found: true, timestamp: "not-a-date" }] })
      .expect(400);
    await authenticated(userId)
      .patch("/api/user/history")
      .send({ queryHistory: [], unexpected: true })
      .expect(400);

    const stored = await authenticated(userId).get("/api/user/history").expect(200);
    expect(stored.body.queryHistory).toEqual(atLimit.queryHistory);
    expect(stored.body.viewedHistory).toHaveLength(10);
    expect(stored.body.scanHistory).toHaveLength(50);
  });

  it("returns empty collections before a user has saved history", async () => {
    const userId = `${USER_PREFIX}empty`;
    await seedApprovedUser(userId);
    const response = await authenticated(userId).get("/api/user/history").expect(200);
    expect(response.body).toEqual(emptyHistory);
  });

  it("deletes history through the user foreign-key cascade", async () => {
    const userId = `${USER_PREFIX}cascade`;
    await seedApprovedUser(userId);
    await authenticated(userId)
      .patch("/api/user/history")
      .send({ queryHistory: ["delete with my account"] })
      .expect(200);

    const beforeDelete = await db
      .select()
      .from(userHistoryTable)
      .where(eq(userHistoryTable.clerkUserId, userId));
    expect(beforeDelete).toHaveLength(1);

    await authenticated(userId).delete("/api/user/me").expect(204);
    const afterDelete = await db
      .select()
      .from(userHistoryTable)
      .where(eq(userHistoryTable.clerkUserId, userId));
    expect(afterDelete).toHaveLength(0);
  });
});