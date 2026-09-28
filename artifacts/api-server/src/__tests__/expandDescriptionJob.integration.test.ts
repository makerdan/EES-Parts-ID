const originalAdminClerkUserId = process.env.ADMIN_CLERK_USER_ID;
process.env.ADMIN_PASSWORD = "jest-description-expansion-secret";

let releaseConcurrent!: () => void;
let concurrentGate: Promise<void> = Promise.resolve();
let concurrentStarted: Promise<void> = Promise.resolve();
let signalConcurrentStarted: () => void = () => {};

function blockConcurrentExpansion(): void {
  concurrentStarted = new Promise<void>((resolve) => {
    signalConcurrentStarted = resolve;
  });
  concurrentGate = new Promise<void>((resolve) => {
    releaseConcurrent = resolve;
  });
}

type IndependentApiInstance = {
  app: typeof app;
};

let independentApiInstance: IndependentApiInstance | undefined;

function getIndependentApiInstance(): IndependentApiInstance {
  if (independentApiInstance) return independentApiInstance;

  // Keep a separate Express/router module graph while sharing the existing DB
  // module and pool, just as separate API processes share PostgreSQL.
  jest.doMock("@workspace/db", () => workspaceDb);
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolatedApp = require("../app").default as typeof app;
      independentApiInstance = { app: isolatedApp };
    });
  } finally {
    jest.dontMock("@workspace/db");
  }
  if (!independentApiInstance) throw new Error("Could not create an independent API instance");
  return independentApiInstance;
}

jest.mock("../lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../lib/poeBot")>("../lib/poeBot");
  return {
    ...actual,
    callPoeBotWithChain: jest.fn(async (
      _feature: string,
      _systemPrompt: string,
      userPrompt: string,
    ) => {
      if (userPrompt.includes("JEST-ITG-DESC-EXACT")) {
        return JSON.stringify({ expandedDescription: "exact threshold result", confidence: 70 });
      }
      if (userPrompt.includes("JEST-ITG-DESC-LOW")) {
        return JSON.stringify({ expandedDescription: "low confidence result", confidence: 69 });
      }
      if (userPrompt.includes("JEST-ITG-DESC-CONCURRENT")) {
        signalConcurrentStarted();
        await concurrentGate;
        return JSON.stringify({ expandedDescription: "must not overwrite manual save", confidence: 95 });
      }
      if (userPrompt.includes("JEST-ITG-DESC-ERROR")) {
        throw new Error("fixture provider failure");
      }
      return JSON.stringify({ expandedDescription: "high confidence result", confidence: 95 });
    }),
    isPoeCallAuthError: jest.fn(() => false),
    isPoeCallTransientError: jest.fn(() => false),
  };
});

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcessWithSSE: jest.fn(),
  batchProcess: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

import supertest from "supertest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import app from "../app";
import { signAdminToken } from "../../__tests__/helpers/adminAuth";
import { callPoeBotWithChain } from "../lib/poeBot";
import * as workspaceDb from "@workspace/db";
import {
  db,
  descriptionExpansionJobTable,
  inventoryTable,
  pool,
} from "@workspace/db";
import { cleanupTestUser, seedTestUser } from "../../__tests__/helpers/testDb";

const CATALOG_PREFIX = "JEST-ITG-DESC-";
const TEST_TIMEOUT_MS = 30_000;
const mockedCallPoeBotWithChain = jest.mocked(callPoeBotWithChain);

function makeAdminToken(): string {
  return signAdminToken();
}

async function waitForJobFinished(token: string): Promise<supertest.Response> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await supertest(app)
      .get("/api/inventory/description-expansion/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    if (!response.body.running) {
      const client = await pool.connect();
      try {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1, $2) AS acquired", [1812, 70]);
        if (lock.rows[0]?.acquired) {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [1812, 70]);
          return response;
        }
      } finally {
        client.release();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Description expansion job did not finish within the test timeout");
}

describe("database description expansion job", () => {
  let protectedNullIds: number[] = [];
  let fixtureIds: number[] = [];
  let existingJobIds: number[] = [];

  beforeAll(async () => {
    const existingJobs = await db
      .select({ id: descriptionExpansionJobTable.id })
      .from(descriptionExpansionJobTable);
    existingJobIds = existingJobs.map((row) => row.id);

    const existingNullRows = await db
      .select({ id: inventoryTable.id })
      .from(inventoryTable)
      .where(
        and(
          isNull(inventoryTable.expandedDescription),
          sql`${inventoryTable.catalog} NOT LIKE ${`${CATALOG_PREFIX}%`}`,
        ),
      );
    protectedNullIds = existingNullRows.map((row) => row.id);
    if (protectedNullIds.length > 0) {
      await db
        .update(inventoryTable)
        .set({ expandedDescription: "JEST-ITG-DESC-PROTECTED" })
        .where(inArray(inventoryTable.id, protectedNullIds));
    }

    await db
      .delete(inventoryTable)
      .where(sql`${inventoryTable.catalog} LIKE ${`${CATALOG_PREFIX}%`}`);

    const rows = await db
      .insert(inventoryTable)
      .values([
        { vendor: "TEST", catalog: "JEST-ITG-DESC-EXACT", description: "exact", binLocations: [], aiKeywords: [] },
        { vendor: "TEST", catalog: "JEST-ITG-DESC-LOW", description: "low", binLocations: [], aiKeywords: [] },
        { vendor: "TEST", catalog: "JEST-ITG-DESC-HIGH", description: "high", binLocations: [], aiKeywords: [] },
        { vendor: "TEST", catalog: "JEST-ITG-DESC-CONCURRENT", description: "concurrent", binLocations: [], aiKeywords: [] },
        { vendor: "TEST", catalog: "JEST-ITG-DESC-ERROR", description: "error", binLocations: [], aiKeywords: [] },
        {
          vendor: "TEST",
          catalog: "JEST-ITG-DESC-EXISTING",
          description: "existing",
          expandedDescription: "keep this value",
          binLocations: [],
          aiKeywords: [],
        },
      ])
      .returning({ id: inventoryTable.id });
    fixtureIds = rows.map((row) => row.id);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    releaseConcurrent();
    await db
      .delete(inventoryTable)
      .where(sql`${inventoryTable.catalog} LIKE ${`${CATALOG_PREFIX}%`}`);
    if (protectedNullIds.length > 0) {
      await db
        .update(inventoryTable)
        .set({ expandedDescription: null })
        .where(inArray(inventoryTable.id, protectedNullIds));
    }
    if (existingJobIds.length > 0) {
      await db
        .delete(descriptionExpansionJobTable)
        .where(sql`${descriptionExpansionJobTable.id} NOT IN (${sql.join(existingJobIds.map((id) => sql`${id}`), sql`, `)})`);
    } else {
      await db
        .delete(descriptionExpansionJobTable)
        .where(sql`${descriptionExpansionJobTable.id} IS NOT NULL`);
    }
    if (originalAdminClerkUserId === undefined) {
      delete process.env.ADMIN_CLERK_USER_ID;
    } else {
      process.env.ADMIN_CLERK_USER_ID = originalAdminClerkUserId;
    }
  }, TEST_TIMEOUT_MS);

  it("requires admin access and protects existing rows during a high-confidence run", async () => {
    blockConcurrentExpansion();
    await supertest(app)
      .get("/api/inventory/description-expansion/status")
      .expect(401);

    const token = makeAdminToken();
    const startResponse = await supertest(app)
      .post("/api/inventory/description-expansion")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(202);
    expect(startResponse.body.job.status).toBe("running");
    expect(startResponse.body.job.total).toBe(5);

    const duplicate = await supertest(app)
      .post("/api/inventory/description-expansion")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(duplicate.status).toBe(409);

    // The matching row has been selected and its generated result is now
    // paused, so the manual edit is guaranteed to land before the worker writes.
    await concurrentStarted;
    const concurrent = fixtureIds[3]!;
    await supertest(app)
      .patch(`/api/inventory/${concurrent}/expanded-description`)
      .set("Authorization", `Bearer ${token}`)
      .send({ expandedDescription: "manual save wins" })
      .expect(200);
    const [manualSave] = await db
      .select({ expandedDescription: inventoryTable.expandedDescription })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, [concurrent]));
    expect(manualSave?.expandedDescription).toBe("manual save wins");

    const stopResponse = await supertest(app)
      .delete("/api/inventory/description-expansion")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(stopResponse.body.job.status).toBe("stopping");
    releaseConcurrent();

    const finished = await waitForJobFinished(token);
    expect(finished.body.status).toBe("cancelled");
    expect(finished.body.processed).toBe(5);
    expect(finished.body.saved).toBe(2);
    expect(finished.body.discarded).toBe(2);
    expect(finished.body.errors).toBe(1);

    const rows = await db
      .select({
        catalog: inventoryTable.catalog,
        expandedDescription: inventoryTable.expandedDescription,
      })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, fixtureIds));
    const byCatalog = new Map(rows.map((row) => [row.catalog, row.expandedDescription]));
    expect(byCatalog.get("JEST-ITG-DESC-EXACT")).toBe("exact threshold result");
    expect(byCatalog.get("JEST-ITG-DESC-HIGH")).toBe("high confidence result");
    expect(byCatalog.get("JEST-ITG-DESC-LOW")).toBeNull();
    expect(byCatalog.get("JEST-ITG-DESC-ERROR")).toBeNull();
    expect(byCatalog.get("JEST-ITG-DESC-CONCURRENT")).toBe("manual save wins");
    expect(byCatalog.get("JEST-ITG-DESC-EXISTING")).toBe("keep this value");

    const persisted = await supertest(app)
      .get("/api/inventory/description-expansion/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(persisted.body.status).toBe("cancelled");
    expect(persisted.body.processed).toBe(5);
    expect(persisted.body.saved).toBe(2);
    expect(persisted.body.discarded).toBe(2);
    expect(persisted.body.errors).toBe(1);
    expect(persisted.body.remaining).toBe(2);
    expect(mockedCallPoeBotWithChain).toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it("claims one worker across separate API instances and preserves its live owner", async () => {
    const independent = getIndependentApiInstance();
    const token = makeAdminToken();
    const secondAdminId = `jest-description-expansion-admin-two-${process.pid}`;
    blockConcurrentExpansion();
    const before = await db.select({ id: descriptionExpansionJobTable.id })
      .from(descriptionExpansionJobTable);
    const previousIds = new Set(before.map((row) => row.id));
    let workerStarted = false;
    let createdJobId: number | undefined;
    let finished: supertest.Response | undefined;
    try {
      await seedTestUser({ clerkUserId: secondAdminId, status: "approved", role: "admin" });
      await db.update(inventoryTable)
        .set({ expandedDescription: null })
        .where(eq(inventoryTable.id, fixtureIds[3]!));
      const instances = [
        { app, token },
        { app: independent.app, token: secondAdminId },
      ];
      const results = await Promise.all(instances.map((instance) =>
        supertest(instance.app).post("/api/inventory/description-expansion")
          .set("Authorization", `Bearer ${instance.token}`).send({})));
      expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
      workerStarted = true;
      await concurrentStarted;

      const rows = await db.select({
        id: descriptionExpansionJobTable.id,
        status: descriptionExpansionJobTable.status,
        ownerId: descriptionExpansionJobTable.ownerId,
        leaseExpiresAt: descriptionExpansionJobTable.leaseExpiresAt,
      }).from(descriptionExpansionJobTable);
      const created = rows.filter((row) => !previousIds.has(row.id));
      expect(created).toHaveLength(1);
      expect(created[0]?.status).toBe("running");
      expect(created[0]?.ownerId).toEqual(expect.any(String));
      expect(created[0]?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
      createdJobId = created[0]!.id;

      const observerIndex = results[0]!.status === 202 ? 1 : 0;
      const observer = instances[observerIndex]!;
      const observed = await supertest(observer.app)
        .get("/api/inventory/description-expansion/status")
        .set("Authorization", `Bearer ${observer.token}`).expect(200);
      expect(observed.body.status).toBe("running");
      expect(observed.body.running).toBe(true);

      await supertest(observer.app).post("/api/inventory/description-expansion")
        .set("Authorization", `Bearer ${observer.token}`).send({}).expect(409);
      const afterDuplicate = await db.select({
        status: descriptionExpansionJobTable.status,
        ownerId: descriptionExpansionJobTable.ownerId,
      }).from(descriptionExpansionJobTable)
        .where(eq(descriptionExpansionJobTable.id, created[0]!.id));
      expect(afterDuplicate[0]).toEqual({
        status: "running",
        ownerId: created[0]!.ownerId,
      });

      const stop = await supertest(observer.app).delete("/api/inventory/description-expansion")
        .set("Authorization", `Bearer ${observer.token}`).expect(200);
      expect(stop.body.job.status).toBe("stopping");
    } finally {
      releaseConcurrent();
      if (workerStarted) finished = await waitForJobFinished(token).catch(() => undefined);
      await cleanupTestUser(secondAdminId);
    }
    expect(finished?.body.processed).toBe(3);
    expect(finished?.body.saved).toBe(1);
    expect(finished?.body.discarded).toBe(1);
    expect(finished?.body.errors).toBe(1);
    const [terminal] = await db.select({
      status: descriptionExpansionJobTable.status,
      ownerId: descriptionExpansionJobTable.ownerId,
      processed: descriptionExpansionJobTable.processed,
    }).from(descriptionExpansionJobTable)
      .where(eq(descriptionExpansionJobTable.id, createdJobId!));
    expect(terminal).toEqual({
      status: "cancelled",
      ownerId: null,
      processed: 3,
    });
  }, TEST_TIMEOUT_MS);

  it("recovers only after a remote owner's persisted lease expires", async () => {
    const independent = getIndependentApiInstance();
    const client = await pool.connect();
    let remoteId: number | undefined;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired", [1812, 70]);
      expect(lock.rows[0]?.acquired).toBe(true);
      const [remote] = await db.insert(descriptionExpansionJobTable)
        .values({
          status: "running",
          ownerId: "live-owner-on-another-api-instance",
          leaseExpiresAt: sql`now() + interval '1 minute'`,
        })
        .returning({ id: descriptionExpansionJobTable.id });
      remoteId = remote!.id;
      const token = makeAdminToken();
      const status = await supertest(independent.app)
        .get("/api/inventory/description-expansion/status")
        .set("Authorization", `Bearer ${token}`).expect(200);
      expect(status.body.status).toBe("running");
      expect(status.body.running).toBe(true);
      await supertest(independent.app).post("/api/inventory/description-expansion")
        .set("Authorization", `Bearer ${token}`).send({}).expect(409);
      const stop = await supertest(independent.app).delete("/api/inventory/description-expansion")
        .set("Authorization", `Bearer ${token}`).expect(200);
      expect(stop.body.job.status).toBe("stopping");
      expect(stop.body.job.stopRequested).toBe(true);
      const [stillLive] = await db.select({
        status: descriptionExpansionJobTable.status,
        ownerId: descriptionExpansionJobTable.ownerId,
        leaseExpiresAt: descriptionExpansionJobTable.leaseExpiresAt,
      })
        .from(descriptionExpansionJobTable)
        .where(eq(descriptionExpansionJobTable.id, remote!.id));
      expect(stillLive?.status).toBe("stopping");
      expect(stillLive?.ownerId).toBe("live-owner-on-another-api-instance");
      expect(stillLive?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [1812, 70]);
      client.release();
    }
    const token = makeAdminToken();
    const beforeExpiry = await supertest(independent.app)
      .get("/api/inventory/description-expansion/status")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(beforeExpiry.body.status).toBe("stopping");
    expect(beforeExpiry.body.running).toBe(true);

    await db.update(descriptionExpansionJobTable)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(descriptionExpansionJobTable.id, remoteId!));
    const afterExpiry = await supertest(independent.app)
      .get("/api/inventory/description-expansion/status")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(afterExpiry.body.status).toBe("failed");
    expect(afterExpiry.body.running).toBe(false);
    const [recovered] = await db.select({
      ownerId: descriptionExpansionJobTable.ownerId,
      leaseExpiresAt: descriptionExpansionJobTable.leaseExpiresAt,
    }).from(descriptionExpansionJobTable)
      .where(eq(descriptionExpansionJobTable.id, remoteId!));
    expect(recovered).toEqual({ ownerId: null, leaseExpiresAt: null });
  }, TEST_TIMEOUT_MS);
});
