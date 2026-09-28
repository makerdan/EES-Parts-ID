/**
 * Integration tests: pinned_keywords must survive every enrichment code path.
 *
 * Covers:
 *  - PATCH /api/inventory/:id/enrich  (per-item admin re-enrich)
 *  - POST  /api/inventory/enrich      (SSE batch enrich)
 *  - Bulk-enrich background job update (runBulkEnrich DB write layer)
 *
 * Each test seeds a row with non-empty pinnedKeywords, triggers the enrichment
 * flow, and asserts that every pinned keyword is present in ai_keywords after
 * the run — even when the AI returns a completely different set of terms.
 */

// ── Env vars — must be set before any module is imported ─────────────────────
const _origAdminPassword = process.env.ADMIN_PASSWORD;
const _origAiProvider = process.env.AI_PROVIDER;
const _origPoeApiKey2 = process.env.POE_API_KEY2;
process.env.ADMIN_PASSWORD = "jest-pinned-kw-secret";
process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";

let mockPoeResponseDelayMs = 0;

afterAll(() => {
  if (_origAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD;
  } else {
    process.env.ADMIN_PASSWORD = _origAdminPassword;
  }
  if (_origAiProvider === undefined) {
    delete process.env.AI_PROVIDER;
  } else {
    process.env.AI_PROVIDER = _origAiProvider;
  }
  if (_origPoeApiKey2 === undefined) {
    delete process.env.POE_API_KEY2;
  } else {
    process.env.POE_API_KEY2 = _origPoeApiKey2;
  }
});

// ── Mock the Poe bot client so no real AI calls are made ──────────────────────
// generateKeywords() calls callPoeBotWithChain internally.
// Returning a valid JSON array of keywords lets the real parsing + merge logic
// run while avoiding any network dependency.
jest.mock("../lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../lib/poeBot")>("../lib/poeBot");
  return {
    ...actual,
    callPoeBotWithChain: jest.fn(async () => {
      if (mockPoeResponseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, mockPoeResponseDelayMs));
      }
      return '["ai-keyword-alpha","ai-keyword-beta"]';
    }),
    isPoeCallAuthError: jest.fn(() => false),
    isPoeCallTransientError: jest.fn(() => false),
  };
});

// ── Mock batchProcessWithSSE to actually execute the per-item callback ────────
// The real implementation fans out concurrently and emits SSE events.
// For tests we just need the callback to run so the DB update inside the
// route handler fires.
jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcessWithSSE: jest.fn(
    async (
      items: unknown[],
      processFn: (item: unknown) => Promise<unknown>,
      onEvent?: (e: { type: string; total?: number; result?: unknown }) => void,
    ) => {
      if (onEvent) onEvent({ type: "started", total: items.length });
      for (const item of items) {
        const result = await processFn(item);
        if (onEvent) onEvent({ type: "progress", result });
      }
    },
  ),
  batchProcess: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import app from "../app";
import { signAdminToken } from "../../__tests__/helpers/adminAuth";
import { callPoeBotWithChain } from "../lib/poeBot";
import { cleanupBulkEnrichHistory, reconcileBulkEnrichJobs } from "../routes/inventory";
import { bulkEnrichJobTable, db, inventoryTable } from "@workspace/db";

// ── Constants ─────────────────────────────────────────────────────────────────
const PINNED = ["Cutler-Hammer", "BAB breaker", "CH-series"];
const AI_KEYWORDS = ["ai-keyword-alpha", "ai-keyword-beta"];
const BULK_ENRICH_TEST_TIMEOUT_MS = 30_000;
const BULK_ENRICH_CLEANUP_TIMEOUT_MS = 30_000;
const bulkEnrichRetentionFixtureIds: number[] = [];

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mockedCallPoeBotWithChain = jest.mocked(callPoeBotWithChain);

function makeAdminToken(): string {
  return signAdminToken(Date.now(), "jest-pinned-kw-secret");
}

/**
 * Insert a single inventory row with pre-populated pinnedKeywords.
 * Returns the inserted row (with generated id).
 */
async function seedWithPinnedKeywords(catalog: string, pinned: string[]) {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: "EATON",
      catalog,
      description: "20A 1-Pole Circuit Breaker",
      binLocations: [],
      aiKeywords: [],
      pinnedKeywords: pinned,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Error(`Seed failed for catalog=${catalog}`);
  return row;
}

/**
 * Triggers the real bulk-enrich background job via POST /api/inventory/bulk-enrich
 * and polls the status endpoint until the job reports running=false.
 * Throws if the job does not finish within the timeout.
 */
async function triggerBulkEnrichAndWait(
  token: string,
  timeoutMs = BULK_ENRICH_TEST_TIMEOUT_MS,
): Promise<void> {
  const startRes = await supertest(app)
    .post("/api/inventory/bulk-enrich")
    .set("Authorization", `Bearer ${token}`)
    .send({})
    .expect(202);

  if (startRes.body?.job?.running === false) return; // already done (edge case)

  await waitForBulkEnrichIdle(token, timeoutMs);
}

async function waitForBulkEnrichIdle(
  token: string,
  timeoutMs = BULK_ENRICH_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    if (!statusRes.body.running) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Bulk-enrich job did not become idle within ${timeoutMs}ms`);
}

async function waitForBulkEnrichRunning(
  token: string,
  timeoutMs = BULK_ENRICH_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    if (statusRes.body.running) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Bulk-enrich job did not become running within ${timeoutMs}ms`);
}

async function stopBulkEnrichAndWait(token: string): Promise<void> {
  const statusRes = await supertest(app)
    .get("/api/inventory/bulk-enrich/status")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);

  if (!statusRes.body.running) return;

  const stopRes = await supertest(app)
    .delete("/api/inventory/bulk-enrich")
    .set("Authorization", `Bearer ${token}`);

  // The job may finish between the status and stop requests.
  expect([200, 409]).toContain(stopRes.status);
  await waitForBulkEnrichIdle(token);
}

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  await stopBulkEnrichAndWait(makeAdminToken());

  // Delete only THIS suite's fixture rows (JEST-ITG-PIN-*). Do NOT use a
  // blanket JEST-ITG-% prefix delete — parallel suites share the database and
  // a prefix delete wipes fixtures another suite is actively using.
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${"JEST-ITG-PIN-%"}`);

  if (bulkEnrichRetentionFixtureIds.length > 0) {
    await db
      .delete(bulkEnrichJobTable)
      .where(inArray(bulkEnrichJobTable.id, bulkEnrichRetentionFixtureIds));
  }
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/inventory/:id/enrich — per-item admin re-enrich
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/enrich — pinned keywords survive re-enrichment", () => {
  it("all pinned keywords appear in ai_keywords after the enrich run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-PATCH", PINNED);

    const token = makeAdminToken();
    const res = await supertest(app)
      .patch(`/api/inventory/${row.id}/enrich`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    // Response body should include every pinned keyword
    const returnedKeywords: string[] = res.body.aiKeywords ?? res.body.ai_keywords ?? [];
    for (const kw of PINNED) {
      expect(returnedKeywords.map((k: string) => k.toLowerCase())).toContain(kw.toLowerCase());
    }

    // Verify the DB was updated consistently with the response
    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    for (const kw of PINNED) {
      expect((dbRow?.aiKeywords ?? []).map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  });

  it("AI-generated keywords and pinned keywords both appear in ai_keywords", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-PATCH-MERGE", PINNED);

    const token = makeAdminToken();
    await supertest(app)
      .patch(`/api/inventory/${row.id}/enrich`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    const saved = dbRow?.aiKeywords ?? [];

    for (const kw of PINNED) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
    for (const kw of AI_KEYWORDS) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  });

  it("pinned keywords appear before AI keywords (pinned-first ordering)", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-PATCH-ORDER", PINNED);

    const token = makeAdminToken();
    await supertest(app)
      .patch(`/api/inventory/${row.id}/enrich`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    const saved = dbRow?.aiKeywords ?? [];
    const lastPinnedIdx = Math.max(
      ...PINNED.map((kw) =>
        saved.findIndex((k) => k.toLowerCase() === kw.toLowerCase()),
      ),
    );
    const firstAiIdx = Math.min(
      ...AI_KEYWORDS.map((kw) =>
        saved.findIndex((k) => k.toLowerCase() === kw.toLowerCase()),
      ),
    );

    // All pinned keywords should come before all AI-only keywords
    expect(lastPinnedIdx).toBeLessThan(firstAiIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/enrich — SSE batch enrich
// ─────────────────────────────────────────────────────────────────────────────
//
// The SSE route's `ids`-based path uses a Drizzle sql`= ANY(${ids})` query
// that requires node-postgres to bind a JavaScript array as a PostgreSQL array
// parameter — which does not work reliably in tests.  Instead we use the
// unenriched-items path (no ids body), which uses a simple IS NULL filter that
// Drizzle handles correctly.  We seed a fresh item with enrichedAt = null and
// check it after the run; items seeded by other tests in this suite are already
// enriched by the time the SSE tests run, so only our target row is picked up.

async function runSseBatchEnrich(token: string) {
  await supertest(app)
    .post("/api/inventory/enrich")
    .set("Authorization", `Bearer ${token}`)
    .send({})
    .buffer(true)
    .parse((res, callback) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => callback(null, data));
    })
    .expect(200);
}

describe("POST /api/inventory/enrich (SSE) — pinned keywords survive re-enrichment", () => {
  beforeEach(async () => {
    // Stamp all currently-unenriched rows with a sentinel enrichedAt so the
    // SSE route's IS NULL filter only finds the item seeded in THIS test.
    await db
      .update(inventoryTable)
      .set({ enrichedAt: new Date("2000-01-01") })
      .where(isNull(inventoryTable.enrichedAt));
  });

  it("all pinned keywords appear in ai_keywords after the SSE enrich run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-SSE", PINNED);

    const token = makeAdminToken();
    await runSseBatchEnrich(token);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    for (const kw of PINNED) {
      expect((dbRow?.aiKeywords ?? []).map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  });

  it("AI-generated keywords and pinned keywords both appear after SSE run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-SSE-MERGE", PINNED);

    const token = makeAdminToken();
    await runSseBatchEnrich(token);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    const saved = dbRow?.aiKeywords ?? [];
    for (const kw of PINNED) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
    for (const kw of AI_KEYWORDS) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/inventory/bulk-enrich — real background job
// ─────────────────────────────────────────────────────────────────────────────
//
// These tests trigger the actual runBulkEnrich background job via the HTTP
// endpoint and poll the status route until the job finishes.  This exercises
// the real code path — including the batch query that selects pinnedKeywords,
// the enrichItemWithRetry call, and the mergeWithPinned + DB UPDATE — rather
// than a synthetic helper.
//
// Each test uses a beforeEach to stamp all currently-unenriched rows with a
// sentinel enrichedAt so the IS NULL filter only picks up the item seeded in
// that test.  Because the mock AI call resolves instantly and there is only
// one unenriched item per test, the job completes in well under the timeout.

describe("POST /api/inventory/bulk-enrich — pinned keywords survive the real bulk job", () => {
  beforeEach(async () => {
    await stopBulkEnrichAndWait(makeAdminToken());

    // Stamp all currently-unenriched rows so the bulk job only picks up our
    // seeded item.  Items enriched by earlier tests already have enrichedAt set.
    await db
      .update(inventoryTable)
      .set({ enrichedAt: new Date("2000-01-01") })
      .where(isNull(inventoryTable.enrichedAt));
  }, BULK_ENRICH_CLEANUP_TIMEOUT_MS);

  it("all pinned keywords appear in ai_keywords after the bulk-enrich run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-BULK", PINNED);
    const token = makeAdminToken();

    await triggerBulkEnrichAndWait(token);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    for (const kw of PINNED) {
      expect((dbRow?.aiKeywords ?? []).map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("reports a stable completed status after normal completion", async () => {
    const token = makeAdminToken();
    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-COMPLETE", PINNED);

    await triggerBulkEnrichAndWait(token);

    const firstStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(firstStatus.body).toMatchObject({
      running: false,
      status: "completed",
      stopRequested: false,
    });
    expect(firstStatus.body.finishedAt).not.toBeNull();

    const repeatedStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(repeatedStatus.body.status).toBe("completed");
    expect(repeatedStatus.body.finishedAt).toBe(firstStatus.body.finishedAt);
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("bounds permanent failures to one batch per run and retries them in a later run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-FAIL", PINNED);
    const token = makeAdminToken();
    mockedCallPoeBotWithChain.mockClear();
    mockedCallPoeBotWithChain.mockRejectedValue(new Error("Permanent AI failure"));
    try {
      await triggerBulkEnrichAndWait(token);
      expect(mockedCallPoeBotWithChain).toHaveBeenCalledTimes(3);
      const first = await supertest(app).get("/api/inventory/bulk-enrich/status")
        .set("Authorization", `Bearer ${token}`).expect(200);
      expect(first.body).toMatchObject({ running: false, status: "failed", processed: 0, errors: 1, total: 1 });
      const [unmodified] = await db.select({ enrichedAt: inventoryTable.enrichedAt })
        .from(inventoryTable).where(eq(inventoryTable.id, row.id));
      expect(unmodified?.enrichedAt).toBeNull();
    } finally {
      mockedCallPoeBotWithChain.mockReset();
    }

    mockedCallPoeBotWithChain.mockResolvedValue('["ai-keyword-alpha","ai-keyword-beta"]');
    await triggerBulkEnrichAndWait(token);
    const second = await supertest(app).get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(second.body).toMatchObject({ status: "completed", processed: 1, errors: 0, total: 1 });
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("does not reconcile an active owner, but repairs a failed terminal write", async () => {
    const token = makeAdminToken();
    const blockedAiCall = makeDeferred<string>();
    mockedCallPoeBotWithChain.mockImplementationOnce(() => blockedAiCall.promise);
    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-RECOVER", PINNED);
    await supertest(app).post("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`).send({}).expect(202);
    await waitForBulkEnrichRunning(token);
    // Wait for the durable row and owner lock before attempting reconciliation.
    let activeId: number | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [row] = await db.select({ id: bulkEnrichJobTable.id })
        .from(bulkEnrichJobTable).where(eq(bulkEnrichJobTable.status, "running"))
        .orderBy(sql`${bulkEnrichJobTable.id} DESC`).limit(1);
      if (row) { activeId = row.id; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(activeId).toBeDefined();
    await reconcileBulkEnrichJobs();
    const [active] = await db.select().from(bulkEnrichJobTable)
      .where(eq(bulkEnrichJobTable.id, activeId!));
    expect(active?.status).toBe("running");

    // Simulate an outage on the terminal write without breaking the test DB.
    const realUpdate = db.update.bind(db);
    const updateSpy = jest.spyOn(db, "update").mockImplementation(((table) => {
      if (table === bulkEnrichJobTable) {
        throw new Error("Terminal database update unavailable");
      }
      return realUpdate(table);
    }) as typeof db.update);
    try {
      blockedAiCall.resolve('["ai-keyword-alpha","ai-keyword-beta"]');
      await waitForBulkEnrichIdle(token);
    } finally {
      updateSpy.mockRestore();
    }
    const failedStatus = await supertest(app).get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(failedStatus.body).toMatchObject({ running: false, status: "failed" });
    const [stale] = await db.select().from(bulkEnrichJobTable)
      .where(eq(bulkEnrichJobTable.id, activeId!));
    expect(stale?.status).toBe("running");
    await reconcileBulkEnrichJobs();
    const [recovered] = await db.select().from(bulkEnrichJobTable)
      .where(eq(bulkEnrichJobTable.id, activeId!));
    expect(recovered?.status).toBe("failed");
    expect(recovered?.finishedAt).not.toBeNull();
    // The next status reader (including a restarted server) sees the terminal row.
    bulkEnrichRetentionFixtureIds.push(activeId!);
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("cancels during retry backoff without waiting through the full attempt budget", async () => {
    const token = makeAdminToken();
    const firstFailure = makeDeferred<void>();
    mockedCallPoeBotWithChain.mockImplementationOnce(async () => {
      firstFailure.resolve();
      throw new Error("Retryable failure");
    });
    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-CANCEL-RETRY", PINNED);
    await supertest(app).post("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`).send({}).expect(202);
    await firstFailure.promise;
    await supertest(app).delete("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`).expect(200);
    await waitForBulkEnrichIdle(token);
    const result = await supertest(app).get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`).expect(200);
    expect(result.body).toMatchObject({ status: "cancelled", errors: 0, processed: 0 });
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("reports stopping before the batch finishes and cancelled after it becomes idle", async () => {
    const token = makeAdminToken();
    mockPoeResponseDelayMs = 250;
    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-CANCEL", PINNED);

    await supertest(app)
      .post("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(202);
    await waitForBulkEnrichRunning(token);

    const stopRes = await supertest(app)
      .delete("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(stopRes.body.job).toMatchObject({
      running: true,
      status: "stopping",
      stopRequested: true,
    });

    await waitForBulkEnrichIdle(token);

    const firstStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(firstStatus.body).toMatchObject({
      running: false,
      status: "cancelled",
      stopRequested: false,
    });
    expect(firstStatus.body.finishedAt).not.toBeNull();

    const repeatedStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(repeatedStatus.body.status).toBe("cancelled");
    expect(repeatedStatus.body.finishedAt).toBe(firstStatus.body.finishedAt);
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it.each([
    ["completed", false],
    ["cancelled", false],
    ["failed", false],
    ["running", true],
    ["stopping", true],
  ] as const)(
    "retains the newest terminal result while handling an older %s row",
    async (obsoleteStatus, shouldRetainObsolete) => {
      const [obsoleteRow, latestTerminalRow] = await db
        .insert(bulkEnrichJobTable)
        .values([
          {
            status: obsoleteStatus,
            startedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            status: "completed",
            startedAt: new Date("2026-01-02T00:00:00.000Z"),
            finishedAt: new Date("2026-01-02T00:01:00.000Z"),
          },
        ])
        .returning({ id: bulkEnrichJobTable.id });

      if (!obsoleteRow || !latestTerminalRow) {
        throw new Error("Failed to seed bulk-enrich retention fixtures");
      }
      bulkEnrichRetentionFixtureIds.push(obsoleteRow.id, latestTerminalRow.id);

      await cleanupBulkEnrichHistory();

      const remainingRows = await db
        .select({ id: bulkEnrichJobTable.id })
        .from(bulkEnrichJobTable)
        .where(inArray(bulkEnrichJobTable.id, [obsoleteRow.id, latestTerminalRow.id]));

      expect(remainingRows.map((row) => row.id)).toContain(latestTerminalRow.id);
      expect(remainingRows.map((row) => row.id).includes(obsoleteRow.id))
        .toBe(shouldRetainObsolete);
    },
  );

  it("AI-generated keywords and pinned keywords both appear after the bulk-enrich run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-MERGE", PINNED);
    const token = makeAdminToken();

    await triggerBulkEnrichAndWait(token);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    const saved = dbRow?.aiKeywords ?? [];
    for (const kw of PINNED) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
    for (const kw of AI_KEYWORDS) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("enrichedAt is set (not NULL) after the bulk-enrich run", async () => {
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-TS", PINNED);
    const token = makeAdminToken();

    await triggerBulkEnrichAndWait(token);

    const [dbRow] = await db
      .select({ enrichedAt: inventoryTable.enrichedAt })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    expect(dbRow?.enrichedAt).not.toBeNull();
    expect(dbRow?.enrichedAt?.getFullYear()).toBeGreaterThan(2000);
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("pinned keywords survive even when AI returns completely disjoint terms", async () => {
    // The mock returns ["ai-keyword-alpha","ai-keyword-beta"] which share no
    // words with PINNED — verifying the merge is not silently bypassed.
    const row = await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-DISJOINT", PINNED);
    const token = makeAdminToken();

    await triggerBulkEnrichAndWait(token);

    const [dbRow] = await db
      .select({ aiKeywords: inventoryTable.aiKeywords })
      .from(inventoryTable)
      .where(eq(inventoryTable.id, row.id))
      .limit(1);

    const saved = dbRow?.aiKeywords ?? [];
    for (const kw of PINNED) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
    for (const kw of AI_KEYWORDS) {
      expect(saved.map((k) => k.toLowerCase())).toContain(kw.toLowerCase());
    }
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  it("cleans up a timed-out run before allowing a sibling bulk job", async () => {
    const blockedAiCall = makeDeferred<string>();
    mockedCallPoeBotWithChain.mockImplementationOnce(() => blockedAiCall.promise);

    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-TIMEOUT", PINNED);
    const token = makeAdminToken();

    await expect(triggerBulkEnrichAndWait(token, 100)).rejects.toThrow(
      "Bulk-enrich job did not become idle within 100ms",
    );

    const activeStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(activeStatus.body.running).toBe(true);

    await supertest(app)
      .delete("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    blockedAiCall.resolve('["ai-keyword-alpha","ai-keyword-beta"]');
    await waitForBulkEnrichIdle(token);

    const idleStatus = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(idleStatus.body.running).toBe(false);

    await seedWithPinnedKeywords("JEST-ITG-PIN-BULK-AFTER-TIMEOUT", PINNED);
    const siblingStart = await supertest(app)
      .post("/api/inventory/bulk-enrich")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(siblingStart.status).toBe(202);
    await waitForBulkEnrichIdle(token);
  }, BULK_ENRICH_TEST_TIMEOUT_MS);

  afterEach(async () => {
    try {
      await stopBulkEnrichAndWait(makeAdminToken());
    } finally {
      mockPoeResponseDelayMs = 0;
    }
  }, BULK_ENRICH_CLEANUP_TIMEOUT_MS);
});
