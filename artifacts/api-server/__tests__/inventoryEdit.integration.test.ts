/**
 * Integration tests for inventory edit PATCH routes.
 *
 * Every test hits the real PostgreSQL database using a seeded item.
 * The only external dependency stubbed out is GCS (uploadCatalogImage) and
 * the image-resize utility — everything else (auth, DB, validation) runs for real.
 *
 * Covered routes:
 *   PATCH /api/inventory/:id/description
 *   PATCH /api/inventory/:id/expanded-description
 *   PATCH /api/inventory/:id/bins
 *   PATCH /api/inventory/:id/barcodes
 *   PATCH /api/inventory/:id/order
 *   PATCH /api/inventory/:id/keywords
 *   PATCH /api/inventory/:id/dimensions  (partial + full)
 *   PATCH /api/inventory/:id/photo       (remove only — GCS upload is stubbed)
 *
 * Auth guard tests reuse the pattern from writeRouteAuth.integration.test.ts.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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

// ── Stub GCS upload and image resize so photo tests work without real GCS ─────
jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn().mockResolvedValue("https://stub.gcs.test/img.jpg"),
}));

jest.mock("../src/utils/imageResize", () => ({
  resizeImages: jest.fn().mockResolvedValue({
    fullBuffer: Buffer.alloc(1),
    thumbnailBuffer: Buffer.alloc(1),
  }),
}));

jest.mock("../src/utils/aiHelpers", () => ({
  ...(
    jest.requireActual("./helpers/aiHelpersMock") as typeof import("./helpers/aiHelpersMock")
  ).createAiHelpersMock(
    jest.requireActual("../src/utils/aiHelpers"),
    { estimateImageBytes: 1024 },
  ),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { db, inventoryTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import express from "express";
import supertest from "supertest";
import app from "../src/app";
import { logger } from "../src/lib/logger";
import routes from "../src/routes";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupEditableItem,
  seedEditableItem,
  seedTestUser,
  cleanupTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";
import { setTestEnv } from "./helpers/testEnv";
import type { EditableItem } from "./helpers/testDb";

// ── Test-wide state ───────────────────────────────────────────────────────────

const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = workerQualifiedUserId("jest-edit-nonadmin");
const PENDING_ADMIN_USER = workerQualifiedUserId("jest-edit-pending-admin");
const BANNED_ADMIN_USER = workerQualifiedUserId("jest-edit-banned-admin");
const PERSISTENCE_DECOY_CATALOG = workerQualifiedUserId("JEST-EDIT-PERSISTENCE-DECOY");

let item: EditableItem;
let persistenceDecoyId: number | undefined;
let restoreTestEnv: (() => void) | undefined;

/** Re-fetch the live DB row so we can assert what was actually committed. */
async function fetchRow(id: number) {
  const [row] = await db
    .select()
    .from(inventoryTable)
    .where(eq(inventoryTable.id, id));
  return row ?? null;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Insert a non-admin user so auth-guard tests can confirm 403.
  // seedTestUser derives the email from the clerkUserId (collision-safe).
  await seedTestUser({ clerkUserId: NON_ADMIN_USER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: PENDING_ADMIN_USER, status: "pending", role: "admin" });
  await seedTestUser({ clerkUserId: BANNED_ADMIN_USER, status: "banned", role: "admin" });

  item = await seedEditableItem();
  const [persistenceDecoy] = await db
    .insert(inventoryTable)
    .values({
      vendor: "JEST-EDIT-DECOY-VENDOR",
      catalog: PERSISTENCE_DECOY_CATALOG,
      description: "Unrelated decoy description",
      binLocations: ["DECOY-BIN-01"],
      aiKeywords: ["decoy keyword"],
      pinnedKeywords: ["decoy keyword"],
      barcodes: ["999999999999"],
      orderPurchase: 1,
      orderQuantity: 2,
      dimensions: { length: 90, width: 80, height: 70, diameter: 5 },
    })
    .returning({ id: inventoryTable.id });
  if (!persistenceDecoy) throw new Error("inventory edit persistence decoy insert returned no row");
  persistenceDecoyId = persistenceDecoy.id;

  // Authenticate all subsequent requests as admin by default.
  restoreTestEnv = setTestEnv({ TEST_DEFAULT_AUTH_USER: ADMIN_TOKEN });
}, 30_000);

afterAll(async () => {
  restoreTestEnv?.();
  if (persistenceDecoyId !== undefined) {
    await db
      .delete(inventoryTable)
      .where(eq(inventoryTable.id, persistenceDecoyId));
  }
  await cleanupEditableItem();
  await cleanupTestUser(NON_ADMIN_USER);
  await cleanupTestUser(PENDING_ADMIN_USER);
  await cleanupTestUser(BANNED_ADMIN_USER);
}, 30_000);

function withAuth(req: supertest.Test, token?: string): supertest.Test {
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

async function expectSuccessfulEditRoute(
  field: string,
  request: supertest.Test,
): Promise<supertest.Response> {
  const response = await request;
  if (response.status !== 200) {
    throw new Error(`${field} edit route failed: ${JSON.stringify(response.body)}`);
  }
  expect(response.status).toBe(200);
  return response;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Load the inventory routes and their database module in a private Jest
 * registry. This is the process-restart equivalent for the module-level
 * dictionary cache: every call starts with a new route module and an empty
 * cache generation while retaining the real test database.
 */
async function loadFreshInventoryRoutes(options?: {
  searchLimiter?: { check: jest.Mock };
}): Promise<{
  routes: typeof routes;
  db: typeof db;
  logger: typeof logger;
}> {
  let freshRoutes!: typeof routes;
  let freshDb!: typeof db;
  let freshLogger!: typeof logger;

  await jest.isolateModulesAsync(async () => {
    jest.doMock("@workspace/db", () => {
      const actual = jest.requireActual("@workspace/db") as typeof import("@workspace/db");
      freshDb = actual.db;
      return actual;
    });
    if (options?.searchLimiter) {
      jest.doMock("../src/lib/rateLimiter", () => {
        const actual = jest.requireActual("../src/lib/rateLimiter") as typeof import("../src/lib/rateLimiter");
        return { ...actual, inventorySearchLimiter: options.searchLimiter };
      });
    }

    freshRoutes = (await import("../src/routes")).default;
    freshLogger = (await import("../src/lib/logger")).logger;
  });

  return { routes: freshRoutes, db: freshDb, logger: freshLogger };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — every write route must reject unauthenticated / non-admin callers
// ─────────────────────────────────────────────────────────────────────────────

describe("Edit route auth guard", () => {
  // Clear TEST_DEFAULT_AUTH_USER so no-token requests actually get 401,
  // then restore it so the rest of the suite keeps the admin default.
  let restoreAuthDefault: (() => void) | undefined;
  beforeAll(() => {
    restoreAuthDefault = setTestEnv({ TEST_DEFAULT_AUTH_USER: undefined });
  });
  afterAll(() => {
    restoreAuthDefault?.();
  });

  type GuardRoute = {
    label: string;
    getPath: () => string;
    body: object;
  };

  const routes: GuardRoute[] = [
    { label: "description",          getPath: () => `/api/inventory/${item?.id ?? 0}/description`,          body: { description: "x" } },
    { label: "bins",                 getPath: () => `/api/inventory/${item?.id ?? 0}/bins`,                 body: { binLocations: ["X1"] } },
    { label: "barcodes",             getPath: () => `/api/inventory/${item?.id ?? 0}/barcodes`,             body: { barcodes: ["999"] } },
    { label: "order",                getPath: () => `/api/inventory/${item?.id ?? 0}/order`,                body: { orderPurchase: 1, orderQuantity: 2 } },
    { label: "keywords",             getPath: () => `/api/inventory/${item?.id ?? 0}/keywords`,             body: { keywords: ["relay"] } },
    { label: "dimensions",           getPath: () => `/api/inventory/${item?.id ?? 0}/dimensions`,           body: { length: 10 } },
    { label: "expanded-description", getPath: () => `/api/inventory/${item?.id ?? 0}/expanded-description`, body: { expandedDescription: "x" } },
    { label: "photo",                getPath: () => `/api/inventory/${item?.id ?? 0}/photo`,                body: { remove: true, slot: 1 } },
  ];

  for (const route of routes) {
    describe(`PATCH …/${route.label}`, () => {
      it("no token → 401", async () => {
        const res = await supertest(app).patch(route.getPath()).send(route.body);
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty("error");
      });

      it("approved non-admin → 403", async () => {
        const res = await withAuth(
          supertest(app).patch(route.getPath()).send(route.body),
          NON_ADMIN_USER,
        );
        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("error");
      });

      it("admin → passes auth (not 401/403)", async () => {
        const res = await withAuth(
          supertest(app).patch(route.getPath()).send(route.body),
          ADMIN_TOKEN,
        );
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });
  }

  it.each([
    ["pending admin", PENDING_ADMIN_USER],
    ["banned admin", BANNED_ADMIN_USER],
  ])("%s → 403 on a representative admin endpoint", async (_label, userId) => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/order`)
        .send({ orderPurchase: 1, orderQuantity: 2 }),
      userId,
    );
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/order
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/order", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ orderPurchase: 0, orderQuantity: 0 })
      .where(eq(inventoryTable.id, item.id));
  });

  it("accepts an approved admin without MFA claims, persists OP/OQ, and returns the generated total", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/order`)
        .send({ orderPurchase: 7, orderQuantity: 8 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body).toMatchObject({
      id: item.id,
      orderPurchase: 7,
      orderQuantity: 8,
      totalOpOq: 15,
    });
    const row = await fetchRow(item.id);
    expect(row).toMatchObject({
      orderPurchase: 7,
      orderQuantity: 8,
      totalOpOq: 15,
    });
  });

  it.each([
    ["a negative OP", { orderPurchase: -1, orderQuantity: 8 }],
    ["a fractional OQ", { orderPurchase: 7, orderQuantity: 1.5 }],
    ["a missing OQ", { orderPurchase: 7 }],
  ])("rejects %s and leaves the prior OP/OQ values intact", async (_label, body) => {
    const before = await fetchRow(item.id);
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/order`)
        .send(body),
      ADMIN_TOKEN,
    ).expect(400);

    const after = await fetchRow(item.id);
    expect(after).toMatchObject({
      orderPurchase: before?.orderPurchase,
      orderQuantity: before?.orderQuantity,
      totalOpOq: before?.totalOpOq,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/description
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/description — happy paths", () => {
  it("updates description and commits the value to the DB", async () => {
    const newDesc = "Updated description via integration test";

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: newDesc }),
      ADMIN_TOKEN,
    ).expect(200);

    // Response shape check
    expect(res.body).toHaveProperty("description", newDesc);
    expect(res.body).toHaveProperty("id", item.id);

    // DB read-back confirms the value was committed
    const row = await fetchRow(item.id);
    expect(row?.description).toBe(newDesc);

    // Restore original value for subsequent tests
    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });

  it("accepts an empty string (clears the description)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: "" }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.description).toBe("");
    const row = await fetchRow(item.id);
    expect(row?.description).toBe("");

    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });

  it("accepts a 500-character description (at the limit)", async () => {
    const atLimit = "x".repeat(500);
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: atLimit }),
      ADMIN_TOKEN,
    ).expect(200);

    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });
});

describe("PATCH /api/inventory/:id/description — error paths", () => {
  it("returns 400 for a 501-character description and leaves DB unchanged", async () => {
    const over = "x".repeat(501);
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: over }),
      ADMIN_TOKEN,
    ).expect(400);

    // DB row must be unchanged
    const row = await fetchRow(item.id);
    expect(row?.description).toBe(item.description);
  });

  it("returns 400 when description is absent", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({}),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/description")
        .send({ description: "hi" }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/expanded-description
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/expanded-description — happy paths", () => {
  it("updates expanded description and returns { success: true }", async () => {
    const text = "A detailed expanded description for the integration test part.";

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/expanded-description`)
        .send({ expandedDescription: text }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body).toEqual({ success: true });

    const row = await fetchRow(item.id);
    expect(row?.expandedDescription).toBe(text);

    await db
      .update(inventoryTable)
      .set({ expandedDescription: item.expandedDescription })
      .where(eq(inventoryTable.id, item.id));
  });

  it("clears expanded description when null is sent", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/expanded-description`)
        .send({ expandedDescription: null }),
      ADMIN_TOKEN,
    ).expect(200);

    const row = await fetchRow(item.id);
    expect(row?.expandedDescription).toBeNull();

    await db
      .update(inventoryTable)
      .set({ expandedDescription: item.expandedDescription })
      .where(eq(inventoryTable.id, item.id));
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/expanded-description")
        .send({ expandedDescription: "x" }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/bins
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/bins — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ binLocations: item.binLocations })
      .where(eq(inventoryTable.id, item.id));
  });

  it("replaces bin locations and commits to DB", async () => {
    const newBins = ["NEW-A1", "NEW-B2", "NEW-C3"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: newBins }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(newBins);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(newBins);
  });

  it("deduplicates case-insensitively before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: ["AA1", "aa1", "BB2"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(["AA1", "BB2"]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(["AA1", "BB2"]);
  });

  it("trims whitespace and drops empty strings before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: ["  TRIM-01  ", "", " ", "TRIM-02"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(["TRIM-01", "TRIM-02"]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(["TRIM-01", "TRIM-02"]);
  });

  it("accepts an empty array and clears the bins in DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual([]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/bins — error paths", () => {
  it("returns 400 when binLocations is not an array and leaves DB unchanged", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: "not-an-array" }),
      ADMIN_TOKEN,
    ).expect(400);

    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(item.binLocations);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/bins")
        .send({ binLocations: ["A1"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/barcodes
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/barcodes — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ barcodes: item.barcodes })
      .where(eq(inventoryTable.id, item.id));
  });

  it("replaces barcodes and commits to DB", async () => {
    const newBarcodes = ["111222333444", "555666777888"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: newBarcodes }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual(newBarcodes);
    const row = await fetchRow(item.id);
    expect((row as unknown as { barcodes?: string[] })?.barcodes).toEqual(newBarcodes);
  });

  it("deduplicates and trims barcodes before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: ["  ABC  ", "ABC", "XYZ"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual(["ABC", "XYZ"]);
  });

  it("accepts an empty array (clears barcodes)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/barcodes — error paths", () => {
  it("returns 400 when barcodes is not an array", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: "123" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/barcodes")
        .send({ barcodes: ["123"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/keywords
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/keywords — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ aiKeywords: item.aiKeywords, pinnedKeywords: item.aiKeywords })
      .where(eq(inventoryTable.id, item.id));
  });

  it("keeps persistent dictionary failures bounded and does not leak inventory data", async () => {
    const failureApp = express();
    failureApp.use(express.json());
    failureApp.use("/api", routes);
    const actualTransaction = db.transaction.bind(db);
    const dictionaryLoad = jest.spyOn(db, "transaction");
    const dictionaryErrorLog = jest.spyOn(logger, "error");
    const sensitiveFailureText = [
      "persistent dictionary database failure",
      item.catalog,
      item.vendor,
      item.description,
      "upload-private-object-key",
    ].join(" | ");
    dictionaryLoad
      // The search limiter transaction is unrelated to dictionary loading.
      .mockImplementationOnce(callback => actualTransaction(callback))
      .mockRejectedValue(new Error(sensitiveFailureText));

    try {
      const response = await supertest(failureApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(500);

      expect(response.body).toEqual({ error: "Search failed" });
      expect(JSON.stringify(response.body)).not.toContain(item.catalog);
      expect(dictionaryLoad).toHaveBeenCalledTimes(3);

      const diagnosticCall = dictionaryErrorLog.mock.calls.find(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === "inventory_dictionary_load_failed"
      ));
      expect(diagnosticCall?.[0]).toMatchObject({
        errorCategory: "dictionary_database_failure",
        attempts: 2,
        errorName: "Error",
      });
      const serializedDiagnostics = JSON.stringify(dictionaryErrorLog.mock.calls);
      expect(serializedDiagnostics).not.toContain(item.catalog);
      expect(serializedDiagnostics).not.toContain(item.vendor);
      expect(serializedDiagnostics).not.toContain(item.description);
      expect(serializedDiagnostics).not.toContain("upload-private-object-key");
      expect(serializedDiagnostics).not.toContain("persistent dictionary database failure");
    } finally {
      dictionaryErrorLog.mockRestore();
      dictionaryLoad.mockRestore();
    }
  });

  it("replaces aiKeywords + pinnedKeywords and commits to DB", async () => {
    const newKeywords = ["breaker", "20a", "panel"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: newKeywords }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.aiKeywords).toEqual(newKeywords);

    const row = await fetchRow(item.id);
    expect(row?.aiKeywords).toEqual(newKeywords);
    // The route also writes pinnedKeywords = keywords to the DB
    expect(row?.pinnedKeywords).toEqual(newKeywords);
  });

  it("bounds stalled dictionary initialization, retries cleanly, and returns saved keywords", async () => {
    const newKeywords = ["durable-search-keyword", "admin-edit-confirmation"];
    const findItem = (body: unknown) => {
      const results = (body as {
        results?: Array<{ item?: { id?: number; aiKeywords?: string[] } }>;
      }).results;
      return results?.find((result) => result.item?.id === item.id)?.item;
    };

    // The first dictionary transaction can lose a connection during the full
    // API workload. The loader must recover in the same request so this
    // persistence contract is not coupled to incidental pool timing.
    const recoveryApp = express();
    recoveryApp.use(express.json());
    recoveryApp.use("/api", routes);
    const actualTransaction = db.transaction.bind(db);
    const dictionaryLoad = jest.spyOn(db, "transaction");
    const dictionaryErrorLog = jest.spyOn(logger, "error");
    let releaseStalledGeneration!: () => void;
    let stalledGenerationSettled = false;
    const stalledGeneration = new Promise<never>((_, reject) => {
      const settleStalledGeneration = () => {
        if (stalledGenerationSettled) return;
        stalledGenerationSettled = true;
        reject(new Error("dictionary statement cancelled"));
      };
      releaseStalledGeneration = settleStalledGeneration;
      // Mirror the database statement timeout: the transaction must settle
      // before the loader is allowed to report its outer deadline failure.
      setTimeout(settleStalledGeneration, 2_100);
    });
    dictionaryLoad
      // The search limiter also uses a transaction. Let that unrelated
      // transaction run before injecting dictionary initialization faults.
      .mockImplementationOnce(callback => actualTransaction(callback))
      // Keep the first dictionary generation pending past its deadline.
      .mockImplementationOnce(() => stalledGeneration as never)
      // Once the cancelled transaction has released its client, the next
      // generation must be able to retry normally.
      .mockImplementationOnce(callback => actualTransaction(callback));

    try {
      const startedAt = Date.now();
      const stalledResponse = await supertest(recoveryApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(500);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(stalledResponse.body).toEqual({ error: "Search failed" });
      expect(JSON.stringify(stalledResponse.body)).not.toContain(item.catalog);

      const diagnosticCall = dictionaryErrorLog.mock.calls.find(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === "inventory_dictionary_load_failed"
      ));
      expect(diagnosticCall?.[0]).toMatchObject({
        errorCategory: "dictionary_database_failure",
        attempts: 1,
        errorName: "DictionaryLoadTimeoutError",
        errorCode: "DICTIONARY_LOAD_TIMEOUT",
      });
      expect(JSON.stringify(diagnosticCall?.[0])).not.toContain(item.catalog);

      // The timed-out generation must be settled before the next request
      // starts. A later generation can then retry without a restart.
      expect(stalledGenerationSettled).toBe(true);
      await supertest(recoveryApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(dictionaryLoad).toHaveBeenCalledTimes(4);

      const beforeSave = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(findItem(beforeSave.body)?.aiKeywords).toEqual(item.aiKeywords);

      await withAuth(
        supertest(app)
          .patch(`/api/inventory/${item.id}/keywords`)
          .send({ keywords: newKeywords }),
        ADMIN_TOKEN,
      ).expect(200);

      const committedRow = await fetchRow(item.id);
      expect(committedRow?.aiKeywords).toEqual(newKeywords);
      expect(committedRow?.pinnedKeywords).toEqual(newKeywords);

      const repeatedSearch = await supertest(app)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(findItem(repeatedSearch.body)?.aiKeywords).toEqual(newKeywords);

      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use("/api", routes);
      const freshAppSearch = await supertest(freshApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(findItem(freshAppSearch.body)?.aiKeywords).toEqual(newKeywords);
    } finally {
      releaseStalledGeneration();
      dictionaryErrorLog.mockRestore();
      dictionaryLoad.mockRestore();
    }
  });

  it("fails closed when dictionary cancellation cleanup is delayed and recovers later", async () => {
    const delayedGeneration = await loadFreshInventoryRoutes();
    const recoveryApp = express();
    recoveryApp.use(express.json());
    recoveryApp.use("/api", delayedGeneration.routes);
    const actualTransaction = delayedGeneration.db.transaction.bind(delayedGeneration.db);
    const dictionaryLoad = jest.spyOn(delayedGeneration.db, "transaction");
    const dictionaryErrorLog = jest.spyOn(delayedGeneration.logger, "error");
    let releaseStalledGeneration!: () => void;
    let stalledGenerationReleased = false;
    const stalledGeneration = new Promise<never>((_, reject) => {
      releaseStalledGeneration = () => {
        if (stalledGenerationReleased) return;
        stalledGenerationReleased = true;
        reject(new Error("delayed dictionary statement cancellation"));
      };
    });
    dictionaryLoad
      // The search limiter transaction is unrelated to dictionary loading.
      .mockImplementationOnce(callback => actualTransaction(callback))
      // Simulate a driver that does not settle the cancelled transaction
      // within the cleanup grace period.
      .mockImplementationOnce(() => stalledGeneration as never);

    try {
      const startedAt = Date.now();
      const stalledResponse = await supertest(recoveryApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(500);

      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(stalledResponse.body).toEqual({ error: "Search failed" });
      expect(JSON.stringify(stalledResponse.body)).not.toContain(item.catalog);

      const diagnosticCall = dictionaryErrorLog.mock.calls.find(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === "inventory_dictionary_load_failed"
      ));
      expect(diagnosticCall?.[0]).toMatchObject({
        errorCategory: "dictionary_cleanup_failure",
        attempts: 1,
        errorName: "DictionaryLoadCleanupTimeoutError",
        errorCode: "DICTIONARY_LOAD_CLEANUP_TIMEOUT",
        timeoutPhase: "cleanup",
      });
      expect(JSON.stringify(diagnosticCall?.[0])).not.toContain(item.catalog);

      // The fail-safe outcome clears the failed cache generation. Once the
      // delayed cancellation finally settles, a later search can retry.
      releaseStalledGeneration();
      expect(stalledGenerationReleased).toBe(true);
      await supertest(recoveryApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(dictionaryLoad).toHaveBeenCalledTimes(4);
    } finally {
      releaseStalledGeneration();
      dictionaryErrorLog.mockRestore();
      dictionaryLoad.mockRestore();
    }
  });

  it("recovers edited keywords across fresh cache generations and bounds persistent failures", async () => {
    const newKeywords = ["process-restart-keyword", "pinned-edit-confirmation"];
    const findItem = (body: unknown) => {
      const results = (body as {
        results?: Array<{ item?: { id?: number; aiKeywords?: string[] } }>;
      }).results;
      return results?.find((result) => result.item?.id === item.id)?.item;
    };

    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: newKeywords }),
      ADMIN_TOKEN,
    ).expect(200);

    const firstGeneration = await loadFreshInventoryRoutes();
    const firstApp = express();
    firstApp.use(express.json());
    firstApp.use("/api", firstGeneration.routes);

    const firstSearch = await supertest(firstApp)
      .post("/api/inventory/search")
      .send({ keywords: item.catalog })
      .expect(200);
    expect(findItem(firstSearch.body)?.aiKeywords).toEqual(newKeywords);

    const afterFirstSearch = await fetchRow(item.id);
    expect(afterFirstSearch?.aiKeywords).toEqual(newKeywords);
    expect(afterFirstSearch?.pinnedKeywords).toEqual(newKeywords);

    const secondGeneration = await loadFreshInventoryRoutes();
    const failureApp = express();
    failureApp.use(express.json());
    failureApp.use("/api", secondGeneration.routes);

    const actualTransaction = secondGeneration.db.transaction.bind(secondGeneration.db);
    const dictionaryLoad = jest.spyOn(secondGeneration.db, "transaction");
    const dictionaryErrorLog = jest.spyOn(secondGeneration.logger, "error");
    dictionaryLoad
      // The search limiter transaction is unrelated to dictionary loading.
      .mockImplementationOnce(callback => actualTransaction(callback))
      .mockRejectedValue(new Error("persistent dictionary database failure after restart"));

    try {
      const failureResponse = await supertest(failureApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(500);

      expect(failureResponse.body).toEqual({ error: "Search failed" });
      expect(JSON.stringify(failureResponse.body)).not.toContain(item.catalog);
      expect(dictionaryLoad).toHaveBeenCalledTimes(3);

      const diagnosticCall = dictionaryErrorLog.mock.calls.find(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === "inventory_dictionary_load_failed"
      ));
      expect(diagnosticCall?.[0]).toMatchObject({
        errorCategory: "dictionary_database_failure",
        attempts: 2,
        errorName: "Error",
      });
      expect(JSON.stringify(diagnosticCall?.[0])).not.toContain(item.catalog);
      expect(JSON.stringify(diagnosticCall?.[0])).not.toContain(
        "persistent dictionary database failure after restart",
      );
    } finally {
      dictionaryErrorLog.mockRestore();
      dictionaryLoad.mockRestore();
    }
  });

  it("shares fresh dictionary initialization across concurrent searches and fails safely", async () => {
    const newKeywords = ["concurrent-restart-keyword", "shared-dictionary-confirmation"];
    const searchCount = 4;
    const findItem = (body: unknown) => {
      const results = (body as {
        results?: Array<{ item?: { id?: number; aiKeywords?: string[] } }>;
      }).results;
      return results?.find((result) => result.item?.id === item.id)?.item;
    };

    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: newKeywords }),
      ADMIN_TOKEN,
    ).expect(200);

    const allSearchesArrived = createDeferred<void>();
    const releaseSearches = createDeferred<void>();
    let searchArrivals = 0;
    const searchLimiter = {
      check: jest.fn(async () => {
        searchArrivals += 1;
        if (searchArrivals === searchCount) allSearchesArrived.resolve();
        await releaseSearches.promise;
        return { allowed: true };
      }),
    };
    const generation = await loadFreshInventoryRoutes({ searchLimiter });
    const generationApp = express();
    generationApp.use(express.json());
    generationApp.use("/api", generation.routes);

    const dictionaryStarted = createDeferred<void>();
    const releaseDictionary = createDeferred<void>();
    const actualTransaction = generation.db.transaction.bind(generation.db);
    const dictionaryLoad = jest.spyOn(generation.db, "transaction").mockImplementation(callback =>
      actualTransaction(async tx => {
        dictionaryStarted.resolve();
        await releaseDictionary.promise;
        return callback(tx);
      }) as never,
    );

    try {
      const responsesPromise = Promise.all(Array.from({ length: searchCount }, () =>
        supertest(generationApp)
          .post("/api/inventory/search")
          .send({ keywords: item.catalog }),
      ));

      // Hold every request before the route can initialize its dictionary so
      // all requests enter the same fresh generation together.
      await allSearchesArrived.promise;
      releaseSearches.resolve();
      await dictionaryStarted.promise;
      releaseDictionary.resolve();

      const responses = await responsesPromise;
      expect(responses).toHaveLength(searchCount);
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(findItem(response.body)?.aiKeywords).toEqual(newKeywords);
      }
      expect(dictionaryLoad).toHaveBeenCalledTimes(1);
    } finally {
      releaseSearches.resolve();
      releaseDictionary.resolve();
      dictionaryLoad.mockRestore();
    }

    const failureSearchesArrived = createDeferred<void>();
    let failureSearchArrivals = 0;
    const failureSearchLimiter = {
      check: jest.fn(async () => {
        failureSearchArrivals += 1;
        if (failureSearchArrivals === searchCount) failureSearchesArrived.resolve();
        return { allowed: true };
      }),
    };
    const failedGeneration = await loadFreshInventoryRoutes({ searchLimiter: failureSearchLimiter });
    const failureApp = express();
    failureApp.use(express.json());
    failureApp.use("/api", failedGeneration.routes);
    const failedActualTransaction = failedGeneration.db.transaction.bind(failedGeneration.db);
    let realTransactionFailureCount = 0;
    const failedDictionaryLoad = jest
      .spyOn(failedGeneration.db, "transaction")
      .mockImplementation(callback =>
        failedActualTransaction(async tx => {
          if (realTransactionFailureCount < 2) {
            realTransactionFailureCount += 1;
            // Keep the failure inside a real transaction after touching the
            // dictionary table, so PostgreSQL must roll it back and release
            // the checked-out client before the shared load fails.
            await tx.execute(sql`select * from "misspelling_map"`);
            await tx.execute(sql`select 1 / 0`);
          }
          return callback(tx);
        }) as never,
      );
    const dictionaryErrorLog = jest.spyOn(failedGeneration.logger, "error");

    try {
      const responsesPromise = Promise.all(Array.from({ length: searchCount }, () =>
        supertest(failureApp)
          .post("/api/inventory/search")
          .send({ keywords: item.catalog }),
      ));

      await failureSearchesArrived.promise;
      const responses = await responsesPromise;
      expect(responses).toHaveLength(searchCount);
      for (const response of responses) {
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Search failed" });
        expect(JSON.stringify(response.body)).not.toContain(item.catalog);
      }
      // The shared failed generation retries once, rather than starting one
      // dictionary transaction per concurrent request. Both transactions
      // touched the real dictionary table before PostgreSQL rolled them back.
      expect(failedDictionaryLoad).toHaveBeenCalledTimes(2);

      const diagnostics = dictionaryErrorLog.mock.calls.filter(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        (fields.event === "inventory_dictionary_load_failed" ||
          fields.event === "inventory_search_failed")
      ));
      expect(diagnostics).toHaveLength(searchCount + 1);
      for (const diagnostic of diagnostics) {
        expect(JSON.stringify(diagnostic)).not.toContain(item.catalog);
      }

      const diagnosticCall = dictionaryErrorLog.mock.calls.find(([fields]) => (
        typeof fields === "object" &&
        fields !== null &&
        "event" in fields &&
        fields.event === "inventory_dictionary_load_failed"
      ));
      expect(diagnosticCall?.[0]).toMatchObject({
        errorCategory: "dictionary_database_failure",
        attempts: 2,
        errorName: "Error",
      });
      expect(JSON.stringify(diagnosticCall?.[0])).not.toContain("Failed query: select 1 / 0");

      // The failed shared generation must clear its cache promise. A later
      // search on the same route instance must reacquire a released client,
      // initialize the dictionaries, and complete without a process restart.
      const recoveryResponse = await supertest(failureApp)
        .post("/api/inventory/search")
        .send({ keywords: item.catalog })
        .expect(200);
      expect(findItem(recoveryResponse.body)?.id).toBe(item.id);
      expect(failedDictionaryLoad).toHaveBeenCalledTimes(3);
    } finally {
      dictionaryErrorLog.mockRestore();
      failedDictionaryLoad.mockRestore();
    }
  });

  it("accepts an empty keywords array (clears keywords)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.aiKeywords).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/keywords — error paths", () => {
  it("returns 400 when keywords is not an array", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: "relay" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/keywords")
        .send({ keywords: ["relay"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/dimensions
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/dimensions — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ dimensions: item.dimensions })
      .where(eq(inventoryTable.id, item.id));
  });

  it("updates a single dimension field (partial) and preserves unrelated fields", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 200 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions.length).toBe(200);

    const row = await fetchRow(item.id);
    const dims = row?.dimensions as typeof item.dimensions;
    expect(dims?.length).toBe(200);
    // width and height were preserved from original (50, 25)
    expect(dims?.width).toBe(50);
    expect(dims?.height).toBe(25);
  });

  it("updates all four dimension fields", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 300, width: 150, height: 75, diameter: 40 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions).toMatchObject({ length: 300, width: 150, height: 75, diameter: 40 });

    const row = await fetchRow(item.id);
    const dims = row?.dimensions as typeof item.dimensions;
    expect(dims?.length).toBe(300);
    expect(dims?.diameter).toBe(40);
  });

  it("clears a dimension field when null is sent", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: null }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions.length).toBeNull();
    const row = await fetchRow(item.id);
    expect((row?.dimensions as typeof item.dimensions)?.length).toBeNull();
  });
});

describe("PATCH /api/inventory/:id/dimensions — error paths", () => {
  it("returns 400 for a negative dimension value and leaves DB unchanged", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: -10 }),
      ADMIN_TOKEN,
    ).expect(400);

    const row = await fetchRow(item.id);
    expect((row?.dimensions as typeof item.dimensions)?.length).toBe(item.dimensions?.length);
  });

  it("returns 400 for a dimension value over 100,000", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 100_001 }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 400 for a non-numeric dimension value", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: "not-a-number" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/dimensions")
        .send({ length: 10 }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/photo — remove only (GCS upload stubbed)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/photo — remove", () => {
  it("removes slot-1 photo and commits null imageUrl to DB", async () => {
    // First set imageUrl to a non-null value directly in DB so remove has something to clear.
    await db
      .update(inventoryTable)
      .set({ imageUrl: "https://existing.example.com/img.jpg", thumbnailUrl: "https://existing.example.com/thumb.jpg" })
      .where(eq(inventoryTable.id, item.id));

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ remove: true, slot: 1 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.imageUrl).toBeNull();
    expect(res.body.thumbnailUrl).toBeNull();

    const row = await fetchRow(item.id);
    expect(row?.imageUrl).toBeNull();
    expect(row?.thumbnailUrl).toBeNull();
  });

  it("removes slot-2 photo and commits null imageUrl2 to DB", async () => {
    await db
      .update(inventoryTable)
      .set({ imageUrl2: "https://existing.example.com/img2.jpg", thumbnailUrl2: "https://existing.example.com/thumb2.jpg" })
      .where(eq(inventoryTable.id, item.id));

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ remove: true, slot: 2 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.imageUrl2).toBeNull();
    expect(res.body.thumbnailUrl2).toBeNull();

    const row = await fetchRow(item.id);
    expect(row?.imageUrl2).toBeNull();
    expect(row?.thumbnailUrl2).toBeNull();
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/photo")
        .send({ remove: true, slot: 1 }),
      ADMIN_TOKEN,
    ).expect(404);
  });

  it("returns 400 when imageBase64 is absent and remove is not set", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ slot: 1 }),
      ADMIN_TOKEN,
    ).expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edit Part → Save Details persistence regression
// ─────────────────────────────────────────────────────────────────────────────

describe("Edit Part Save Details — multi-field database persistence", () => {
  it("persists every edited field and leaves an unrelated inventory row unchanged", async () => {
    if (persistenceDecoyId === undefined) {
      throw new Error("inventory edit persistence decoy was not seeded");
    }

    // Give the dimensions route a non-null field that this edit intentionally
    // omits. The final read must prove the route merged the patch instead of
    // replacing the entire JSONB value.
    await db
      .update(inventoryTable)
      .set({
        dimensions: { length: 100, width: 50, height: 25, diameter: 9 },
      })
      .where(eq(inventoryTable.id, item.id));

    const decoyBefore = await fetchRow(persistenceDecoyId);
    expect(decoyBefore).toMatchObject({
      id: persistenceDecoyId,
      vendor: "JEST-EDIT-DECOY-VENDOR",
      catalog: PERSISTENCE_DECOY_CATALOG,
      description: "Unrelated decoy description",
      binLocations: ["DECOY-BIN-01"],
      aiKeywords: ["decoy keyword"],
      pinnedKeywords: ["decoy keyword"],
      barcodes: ["999999999999"],
      orderPurchase: 1,
      orderQuantity: 2,
      totalOpOq: 3,
      dimensions: { length: 90, width: 80, height: 70, diameter: 5 },
    });

    const editRequests: Array<[string, supertest.Test]> = [
      [
        "description",
        withAuth(
          supertest(app)
            .patch(`/api/inventory/${item.id}/description`)
            .send({ description: "  Updated relay  " }),
          ADMIN_TOKEN,
        ),
      ],
      [
        "bins",
        withAuth(
          supertest(app)
            .patch(`/api/inventory/${item.id}/bins`)
            .send({ binLocations: ["EDIT-BIN-01", "  B2-07  ", "b2-07"] }),
          ADMIN_TOKEN,
        ),
      ],
      [
        "keywords",
        withAuth(
          supertest(app)
            .patch(`/api/inventory/${item.id}/keywords`)
            .send({ keywords: [" replacement keyword "] }),
          ADMIN_TOKEN,
        ),
      ],
      [
        "order",
        withAuth(
          supertest(app)
            .patch(`/api/inventory/${item.id}/order`)
            .send({ orderPurchase: 7, orderQuantity: 8 }),
          ADMIN_TOKEN,
        ),
      ],
      [
        "dimensions",
        withAuth(
          supertest(app)
            .patch(`/api/inventory/${item.id}/dimensions`)
            .send({ length: 12.3, width: 4.6, height: 7 }),
          ADMIN_TOKEN,
        ),
      ],
    ];

    for (const [field, request] of editRequests) {
      await expectSuccessfulEditRoute(field, request);
    }

    // This is a direct database read, not a route response or application
    // cache read. It is intentionally performed only after every PATCH has
    // completed so the assertion covers durable state across the full edit.
    const editedRow = await fetchRow(item.id);
    expect(editedRow).toMatchObject({
      id: item.id,
      description: "Updated relay",
      binLocations: ["EDIT-BIN-01", "B2-07"],
      aiKeywords: ["replacement keyword"],
      pinnedKeywords: ["replacement keyword"],
      orderPurchase: 7,
      orderQuantity: 8,
      totalOpOq: 15,
      dimensions: { length: 12.3, width: 4.6, height: 7, diameter: 9 },
    });
    expect(editedRow?.dimensions).toEqual({
      length: 12.3,
      width: 4.6,
      height: 7,
      diameter: 9,
    });

    const decoyAfter = await fetchRow(persistenceDecoyId);
    expect(decoyAfter).toMatchObject({
      id: persistenceDecoyId,
      vendor: "JEST-EDIT-DECOY-VENDOR",
      catalog: PERSISTENCE_DECOY_CATALOG,
      description: "Unrelated decoy description",
      binLocations: ["DECOY-BIN-01"],
      aiKeywords: ["decoy keyword"],
      pinnedKeywords: ["decoy keyword"],
      barcodes: ["999999999999"],
      orderPurchase: 1,
      orderQuantity: 2,
      totalOpOq: 3,
      dimensions: { length: 90, width: 80, height: 70, diameter: 5 },
    });
  });
});
