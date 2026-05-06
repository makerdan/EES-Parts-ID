/**
 * Integration tests for POST /api/categories/reclassify.
 *
 * Critical correctness guarantee: the job must NEVER overwrite rows where
 * classified_by = 'manual'. A single reclassify run is shared across all
 * pipeline-correctness tests to avoid paying the full-table-scan cost
 * multiple times.
 *
 * Test matrix (all checked in ONE shared reclassify run):
 *   MANUAL item   → assignment node + classifiedBy untouched
 *   RULE item     → re-classified (rule overwrites stale rule)
 *   AI item       → re-classified (rule overwrites stale AI)
 *   NEW item      → created for the first time (edge case: no prior row)
 *   UNKNOWN item  → falls back to uncategorized-type (no rule matches)
 *
 * OpenAI is mocked so no API key is required.
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

// ── Imports ────────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { eq, sql, inArray } from "drizzle-orm";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import {
  db,
  categoryNodeTable,
  inventoryCategoryTable,
  inventoryTable,
} from "@workspace/db";
import { seedTaxonomy } from "../src/seed/taxonomy";
import { closePool } from "./helpers/testDb";

// ── Constants ──────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-reclassify-test-secret";
const CATALOG_PREFIX = "JEST-ITG-RECLS-";

/** beforeAll / beforeEach timeout. The reclassify endpoint scans the full
 *  inventory table; allow up to 3 minutes on a populated database. */
const SETUP_TIMEOUT = 180_000;

let adminToken: string;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a raw SSE response body into an array of event payloads. */
function parseSseEvents(body: string): Record<string, unknown>[] {
  return body
    .split(/\n\n+/)
    .map(chunk => chunk.replace(/^data:\s*/m, "").trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);
}

/** Insert a bare inventory row and return its generated id. */
async function insertItem(opts: {
  catalog: string;
  description: string;
  vendor?: string;
}): Promise<number> {
  const [row] = await db
    .insert(inventoryTable)
    .values({
      vendor: (opts.vendor ?? "JEST").toUpperCase(),
      catalog: opts.catalog,
      description: opts.description,
      binLocations: [],
      aiKeywords: [],
    })
    .returning({ id: inventoryTable.id });
  return row!.id;
}

/** Insert an inventory_category row for the given item. */
async function insertAssignment(opts: {
  inventoryId: number;
  categoryNodeId: number;
  classifiedBy: "manual" | "rule" | "ai";
  confidence?: string;
}): Promise<void> {
  await db.insert(inventoryCategoryTable).values({
    inventoryId: opts.inventoryId,
    categoryNodeId: opts.categoryNodeId,
    classifiedBy: opts.classifiedBy,
    confidence: opts.confidence ?? "0.8500",
  });
}

/** Fetch the current assignment row for an inventory item (null if missing). */
async function getAssignment(inventoryId: number) {
  const [row] = await db
    .select()
    .from(inventoryCategoryTable)
    .where(eq(inventoryCategoryTable.inventoryId, inventoryId))
    .limit(1);
  return row ?? null;
}

/** Fetch the slug of the node currently assigned to an inventory item. */
async function getAssignedSlug(inventoryId: number): Promise<string | null> {
  const row = await getAssignment(inventoryId);
  if (!row) return null;
  const [node] = await db
    .select({ slug: categoryNodeTable.slug })
    .from(categoryNodeTable)
    .where(eq(categoryNodeTable.id, row.categoryNodeId))
    .limit(1);
  return node?.slug ?? null;
}

/** Return a leaf "type" node that is definitively NOT the node our test items
 *  will be classified into. We exclude uncategorized-type and breaker-standard
 *  so that stale-assignment tests start from a clearly wrong node, and ordering
 *  is pinned to slug for reproducibility across runs. */
async function getWrongTypeNode(): Promise<{ id: number; slug: string }> {
  const [node] = await db
    .select({ id: categoryNodeTable.id, slug: categoryNodeTable.slug })
    .from(categoryNodeTable)
    .where(
      sql`${categoryNodeTable.level} = 'type'
          AND ${categoryNodeTable.slug} NOT IN ('uncategorized-type', 'breaker-standard')`,
    )
    .orderBy(categoryNodeTable.slug)
    .limit(1);
  if (!node) throw new Error("No suitable type node — run seedTaxonomy first");
  return node;
}

/** Remove all fixture items (and their category rows) from the database. */
async function cleanupFixtures(): Promise<void> {
  const fixtures = await db
    .select({ id: inventoryTable.id })
    .from(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + "%"}`);
  if (fixtures.length > 0) {
    const ids = fixtures.map(r => r.id);
    await db
      .delete(inventoryCategoryTable)
      .where(inArray(inventoryCategoryTable.inventoryId, ids));
    await db
      .delete(inventoryTable)
      .where(sql`${inventoryTable.catalog} LIKE ${CATALOG_PREFIX + "%"}`);
  }
}

// ── Top-level lifecycle ────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await seedTaxonomy();
}, 30_000);

afterAll(async () => {
  await closePool();
}, 30_000);

// ── Auth guard (fast — no full-scan) ──────────────────────────────────────────
describe("POST /api/categories/reclassify — auth", () => {
  it("returns 401 without a valid admin token", async () => {
    await supertest(app)
      .post("/api/categories/reclassify")
      .send({ useAi: false })
      .expect(401);
  });
});

// ── Pipeline correctness (single shared reclassify run) ───────────────────────
// All assertions use data seeded in beforeAll and query results after the ONE
// shared reclassify call, so the expensive full-table scan happens only once.
describe("POST /api/categories/reclassify — pipeline correctness", () => {
  let manualId: number;
  let ruleId: number;
  let aiId: number;
  let newId: number;
  let unknownId: number;
  let manualNodeId: number;

  let sseEvents: Record<string, unknown>[];
  let doneEvent: Record<string, unknown>;
  let responseContentType: string;

  beforeAll(async () => {
    await cleanupFixtures();

    const typeNode = await getWrongTypeNode();
    manualNodeId = typeNode.id;

    // MANUAL: manually pinned to typeNode; must survive completely untouched.
    // Uses a "breaker" description so the rule engine would change it if the
    // manual guard were not in place.
    manualId = await insertItem({
      catalog: `${CATALOG_PREFIX}MANUAL-001`,
      description: "20A circuit breaker single pole manual override",
    });
    await insertAssignment({
      inventoryId: manualId,
      categoryNodeId: manualNodeId,
      classifiedBy: "manual",
      confidence: "1.0000",
    });

    // RULE: previously assigned by rule but to the wrong node; reclassify
    // must overwrite with the correct rule result (breaker-standard).
    ruleId = await insertItem({
      catalog: `${CATALOG_PREFIX}RULE-001`,
      description: "20A circuit breaker standard pole",
    });
    await insertAssignment({
      inventoryId: ruleId,
      categoryNodeId: manualNodeId,
      classifiedBy: "rule",
    });

    // AI: currently assigned by AI to the wrong node; same expectation.
    aiId = await insertItem({
      catalog: `${CATALOG_PREFIX}AI-001`,
      description: "20A circuit breaker standard two pole",
    });
    await insertAssignment({
      inventoryId: aiId,
      categoryNodeId: manualNodeId,
      classifiedBy: "ai",
    });

    // NEW: no assignment row at all — edge case for items never classified.
    newId = await insertItem({
      catalog: `${CATALOG_PREFIX}NEW-001`,
      description: "20A circuit breaker standard single pole new",
    });

    // UNKNOWN: description matches no rule → must land on uncategorized-type.
    unknownId = await insertItem({
      catalog: `${CATALOG_PREFIX}UNKNOWN-001`,
      description: "unrecognized widget xyz completely novel part",
    });

    // ── Single reclassify run shared by all tests below ───────────────────────
    const res = await supertest(app)
      .post("/api/categories/reclassify")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ useAi: false })
      .expect(200);

    responseContentType = res.headers["content-type"] as string;
    sseEvents = parseSseEvents(res.text);
    doneEvent = sseEvents.find(e => e["done"] === true) ?? {};
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await cleanupFixtures();
  }, 15_000);

  // ── SSE stream shape ─────────────────────────────────────────────────────────
  it("responds with content-type text/event-stream", () => {
    expect(responseContentType).toMatch(/text\/event-stream/);
  });

  it("emits at least one progress event before the done event", () => {
    expect(sseEvents.length).toBeGreaterThanOrEqual(2);
    const first = sseEvents[0]!;
    expect(typeof first["total"]).toBe("number");
  });

  it("includes processed, ruleHits, and skippedManual in the done event", () => {
    expect(doneEvent["done"]).toBe(true);
    expect(typeof doneEvent["processed"]).toBe("number");
    expect(typeof doneEvent["ruleHits"]).toBe("number");
    expect(typeof doneEvent["skippedManual"]).toBe("number");
  });

  // ── Manual assignment preserved ──────────────────────────────────────────────
  it("leaves classifiedBy as 'manual' for the manual item", async () => {
    const row = await getAssignment(manualId);
    expect(row).not.toBeNull();
    expect(row!.classifiedBy).toBe("manual");
  });

  it("leaves the category node unchanged for the manual item", async () => {
    const row = await getAssignment(manualId);
    expect(row!.categoryNodeId).toBe(manualNodeId);
  });

  it("leaves the confidence at 1.0 for the manual item", async () => {
    const row = await getAssignment(manualId);
    expect(Number(row!.confidence)).toBe(1.0);
  });

  it("counts at least one skippedManual in the done event", () => {
    expect(Number(doneEvent["skippedManual"])).toBeGreaterThanOrEqual(1);
  });

  // ── Stale rule assignment updated ────────────────────────────────────────────
  it("re-classifies the stale rule item (classifiedBy stays 'rule')", async () => {
    const row = await getAssignment(ruleId);
    expect(row).not.toBeNull();
    expect(row!.classifiedBy).toBe("rule");
  });

  it("re-classifies the stale rule item to breaker-standard", async () => {
    expect(await getAssignedSlug(ruleId)).toBe("breaker-standard");
  });

  // ── Stale AI assignment updated ──────────────────────────────────────────────
  it("re-classifies the stale AI item (rule engine wins over AI)", async () => {
    const row = await getAssignment(aiId);
    expect(row).not.toBeNull();
    expect(row!.classifiedBy).toBe("rule");
  });

  it("re-classifies the stale AI item to breaker-standard", async () => {
    expect(await getAssignedSlug(aiId)).toBe("breaker-standard");
  });

  // ── Edge case: item with no prior assignment ──────────────────────────────────
  it("creates an assignment for the previously unclassified item", async () => {
    const row = await getAssignment(newId);
    expect(row).not.toBeNull();
  });

  it("classifies the new item as rule (not manual)", async () => {
    const row = await getAssignment(newId);
    expect(row!.classifiedBy).not.toBe("manual");
  });

  it("classifies the new breaker item to breaker-standard", async () => {
    expect(await getAssignedSlug(newId)).toBe("breaker-standard");
  });

  // ── Edge case: unknown item → uncategorized fallback ─────────────────────────
  it("assigns uncategorized-type when no rule matches the description", async () => {
    expect(await getAssignedSlug(unknownId)).toBe("uncategorized-type");
  });
});
