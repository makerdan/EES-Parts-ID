/**
 * Integration tests for pinned-keyword preservation across re-enrichment.
 *
 * Verifies the end-to-end guarantee: a BAB breaker that already has
 * "Cutler-Hammer" pinned will NOT lose that keyword when PATCH /:id/enrich
 * re-runs and the AI returns a completely different keyword set.
 *
 * Uses a real PostgreSQL database.  The AI (Poe) call is mocked so no live
 * API key is required.
 */

// ── Module mocks — must be declared before any imports ────────────────────────
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

jest.mock("../src/lib/poeBot", () => ({
  callPoeBotWithChain: jest.fn(),
  tryPoeBotChain: jest.fn(),
  isPoeCallAuthError: jest.fn(() => false),
  isPoeCallTransientError: jest.fn(() => false),
  PoeBotChainExhaustedError: class PoeBotChainExhaustedError extends Error {},
}));

// answerCache: must always return a Promise (never undefined) so .catch() works.
jest.mock("../src/lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, inventoryTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { callPoeBotWithChain } from "../src/lib/poeBot";
import { invalidateReferenceAnswerCache } from "../src/lib/answerCache";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-pinning-itg-secret";
const CATALOG_PREFIX = "JEST-PIN-";

let adminToken: string;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function cleanup() {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${"JEST-PIN-%"}`);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  await cleanup();
}, 30_000);

afterAll(async () => {
  await cleanup();
  await closePool();
}, 30_000);

beforeEach(() => {
  // Restore implementations that resetAllMocks would clear.
  // callPoeBotWithChain is set per-test via mockResolvedValueOnce.
  // invalidateReferenceAnswerCache must always return a real Promise.
  (callPoeBotWithChain as jest.Mock).mockReset();
  (invalidateReferenceAnswerCache as jest.Mock).mockResolvedValue(undefined);
});

afterEach(async () => {
  await cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/inventory/:id/enrich — pinned keyword preservation", () => {
  it("retains 'Cutler-Hammer' after re-enrichment when it is in pinnedKeywords", async () => {
    // Arrange: create a BAB breaker with "Cutler-Hammer" already pinned
    // (this simulates the post-migration state after 0027_pinned_keywords.sql runs).
    const [inserted] = await db
      .insert(inventoryTable)
      .values({
        vendor: "ETN",
        catalog: `${CATALOG_PREFIX}BAB2020`,
        description: "BAB 20A 2-Pole 120/240V Breaker",
        aiKeywords: ["Cutler-Hammer", "BAB breaker", "circuit breaker", "20A", "2 pole"],
        pinnedKeywords: ["Cutler-Hammer", "BAB breaker", "circuit breaker", "20A", "2 pole"],
        enrichedAt: new Date(),
      })
      .returning();

    expect(inserted).toBeDefined();
    const id = inserted!.id;

    // Mock the AI to return a completely different set of keywords that do NOT
    // include "Cutler-Hammer" — simulating a future enrichment run where the
    // model forgets the brand association.
    (callPoeBotWithChain as jest.Mock).mockResolvedValueOnce(
      JSON.stringify(["circuit breaker", "miniature breaker", "20 amp", "2 pole", "panel breaker"]),
    );

    // Act: trigger per-item re-enrichment via the admin endpoint.
    const res = await supertest(app)
      .patch(`/api/inventory/${id}/enrich`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // Assert: "Cutler-Hammer" must still be present in ai_keywords.
    expect(res.body.aiKeywords).toContain("Cutler-Hammer");
    expect(res.body.aiKeywords).toContain("BAB breaker");

    // AI-only keywords must also be present (merge, not replace).
    expect(res.body.aiKeywords).toContain("miniature breaker");
    expect(res.body.aiKeywords).toContain("panel breaker");

    // Confirm the DB row agrees with the response body.
    const [row] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .limit(1);
    expect(row!.aiKeywords).toContain("Cutler-Hammer");
    expect(row!.aiKeywords).toContain("BAB breaker");
    // pinnedKeywords must be unchanged by enrichment.
    expect(row!.pinnedKeywords).toContain("Cutler-Hammer");
  });

  it("loses 'Cutler-Hammer' when pinnedKeywords is empty (pre-backfill scenario)", async () => {
    // This test documents the failure mode that existed before pinned_keywords
    // was introduced — confirming the backfill step is what makes things durable.
    // A row with ai_keywords containing "Cutler-Hammer" but empty pinnedKeywords
    // will lose the keyword on re-enrichment (expected — it was never pinned).
    const [inserted] = await db
      .insert(inventoryTable)
      .values({
        vendor: "ETN",
        catalog: `${CATALOG_PREFIX}BAB2021-UNPINNED`,
        description: "BAB 20A 2-Pole Breaker",
        aiKeywords: ["Cutler-Hammer", "circuit breaker", "20A"],
        pinnedKeywords: [],  // not pinned — simulates pre-backfill state
        enrichedAt: new Date(),
      })
      .returning();

    const id = inserted!.id;

    // AI returns keywords that do NOT include "Cutler-Hammer".
    (callPoeBotWithChain as jest.Mock).mockResolvedValueOnce(
      JSON.stringify(["circuit breaker", "miniature breaker", "20 amp"]),
    );

    const res = await supertest(app)
      .patch(`/api/inventory/${id}/enrich`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // Without pinning, "Cutler-Hammer" is lost — this is WHY the backfill matters.
    expect(res.body.aiKeywords).not.toContain("Cutler-Hammer");
    // AI keywords come through fine.
    expect(res.body.aiKeywords).toContain("miniature breaker");
  });

  it("PATCH /:id/keywords pins keywords so the next re-enrichment preserves them", async () => {
    // Arrange: start with a row that has no pinned keywords.
    const [inserted] = await db
      .insert(inventoryTable)
      .values({
        vendor: "ETN",
        catalog: `${CATALOG_PREFIX}BAB2022-FRESHPIN`,
        description: "BAB 20A 1-Pole Breaker",
        aiKeywords: ["circuit breaker", "20A"],
        pinnedKeywords: [],
        enrichedAt: new Date(),
      })
      .returning();

    const id = inserted!.id;

    // Admin manually sets keywords (including "Cutler-Hammer") via the keywords endpoint.
    await supertest(app)
      .patch(`/api/inventory/${id}/keywords`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ keywords: ["Cutler-Hammer", "BAB breaker", "circuit breaker", "20A"] })
      .expect(200);

    // Verify pinnedKeywords was also updated.
    const [afterPin] = await db
      .select()
      .from(inventoryTable)
      .where(eq(inventoryTable.id, id))
      .limit(1);
    expect(afterPin!.pinnedKeywords).toContain("Cutler-Hammer");

    // Now re-enrich: AI omits "Cutler-Hammer".
    (callPoeBotWithChain as jest.Mock).mockResolvedValueOnce(
      JSON.stringify(["circuit breaker", "miniature breaker", "20 amp", "single pole"]),
    );

    const res = await supertest(app)
      .patch(`/api/inventory/${id}/enrich`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // "Cutler-Hammer" must survive because it was pinned via PATCH /:id/keywords.
    expect(res.body.aiKeywords).toContain("Cutler-Hammer");
    expect(res.body.aiKeywords).toContain("BAB breaker");
    expect(res.body.aiKeywords).toContain("miniature breaker");
  });
});
