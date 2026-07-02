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
process.env.ADMIN_PASSWORD = "jest-pinned-kw-secret";
process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";

// ── Mock the Poe bot client so no real AI calls are made ──────────────────────
// generateKeywords() calls callPoeBotWithChain internally.
// Returning a valid JSON array of keywords lets the real parsing + merge logic
// run while avoiding any network dependency.
jest.mock("../lib/poeBot", () => ({
  callPoeBotWithChain: jest.fn().mockResolvedValue('["ai-keyword-alpha","ai-keyword-beta"]'),
  isPoeCallAuthError: jest.fn(() => false),
  isPoeCallTransientError: jest.fn(() => false),
}));

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
import { eq, isNull } from "drizzle-orm";
import app from "../app";
import { signAdminToken } from "../routes/admin";
import { db, inventoryTable } from "@workspace/db";
import { cleanupFixtures, closePool } from "../../__tests__/helpers/testDb";

// ── Constants ─────────────────────────────────────────────────────────────────
const PINNED = ["Cutler-Hammer", "BAB breaker", "CH-series"];
const AI_KEYWORDS = ["ai-keyword-alpha", "ai-keyword-beta"];

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
  timeoutMs = 15_000,
): Promise<void> {
  const startRes = await supertest(app)
    .post("/api/inventory/bulk-enrich")
    .set("Authorization", `Bearer ${token}`)
    .send({})
    .expect(202);

  if (startRes.body?.job?.running === false) return; // already done (edge case)

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const statusRes = await supertest(app)
      .get("/api/inventory/bulk-enrich/status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    if (!statusRes.body.running) return;
  }
  throw new Error(`Bulk-enrich job did not finish within ${timeoutMs}ms`);
}

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  await cleanupFixtures();
  await closePool();
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
    // Stamp all currently-unenriched rows so the bulk job only picks up our
    // seeded item.  Items enriched by earlier tests already have enrichedAt set.
    await db
      .update(inventoryTable)
      .set({ enrichedAt: new Date("2000-01-01") })
      .where(isNull(inventoryTable.enrichedAt));
  });

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
  });

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
  });

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
  });

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
  });
});
