/**
 * Integration tests confirming primary vendors always win over extended vendor
 * matches when building the reverseVendorMap, and that seedVendors preserves
 * is_primary = true on all primary entries even after an upsert.
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
import { db } from "@workspace/db";
import { vendorMapTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import {
  PRIMARY_VENDORS,
  seedVendors,
} from "../src/seed/dictionaries";

// ── Helpers ───────────────────────────────────────────────────────────────────

const JEST_VMP_PREFIX = "JEST-VMP-";

async function cleanupTestVendors() {
  await db
    .delete(vendorMapTable)
    .where(like(vendorMapTable.code, `${JEST_VMP_PREFIX}%`));
}

/**
 * Replicate the reverseVendorMap build logic from inventory.ts so the test
 * can assert the result without going through the HTTP layer.
 * Extended vendors are written first; primary vendors overwrite on conflict.
 */
async function buildReverseVendorMap(): Promise<Map<string, string>> {
  const vendors = await db.select().from(vendorMapTable);
  const map = new Map<string, string>();
  const extended = vendors.filter((v) => !v.isPrimary);
  const primary = vendors.filter((v) => v.isPrimary);
  for (const v of extended) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }
  for (const v of primary) {
    for (const name of v.names) map.set(name.toLowerCase(), v.code);
  }
  // Explicit priority overrides: mirror the PRIORITY_CODES step in inventory.ts
  // so that shared aliases always resolve to the priority code, regardless of
  // DB row order (non-deterministic SELECT order).
  const PRIORITY_CODES = ["CRS"];
  for (const code of PRIORITY_CODES) {
    const entry = primary.find((v) => v.code === code);
    if (entry) {
      for (const name of entry.names) map.set(name.toLowerCase(), code);
    }
  }
  return map;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await cleanupTestVendors();
}, 15_000);

afterAll(async () => {
  await cleanupTestVendors();
}, 15_000);

afterEach(async () => {
  await cleanupTestVendors();
});

// ─────────────────────────────────────────────────────────────────────────────
// reverseVendorMap priority
// ─────────────────────────────────────────────────────────────────────────────

describe("reverseVendorMap — primary vendors win over extended on name conflicts", () => {
  it("resolves to primary code when a synthetic name appears in both tiers", async () => {
    const sharedName = "jest conflict vendor name";

    // Extended entry (written first by the seed loop)
    await db
      .insert(vendorMapTable)
      .values({ code: `${JEST_VMP_PREFIX}EXT`, names: [sharedName], notes: "test extended", isPrimary: false })
      .onConflictDoUpdate({
        target: vendorMapTable.code,
        set: { names: [sharedName], notes: "test extended", isPrimary: false },
      });

    // Primary entry (written second — must overwrite)
    await db
      .insert(vendorMapTable)
      .values({ code: `${JEST_VMP_PREFIX}PRI`, names: [sharedName], notes: "test primary", isPrimary: true })
      .onConflictDoUpdate({
        target: vendorMapTable.code,
        set: { names: [sharedName], notes: "test primary", isPrimary: true },
      });

    const map = await buildReverseVendorMap();
    expect(map.get(sharedName)).toBe(`${JEST_VMP_PREFIX}PRI`);
  });

  it("resolves 'eaton' to the primary code CHD, not the extended code ETN", async () => {
    // 'eaton' is a name in both:
    //   VENDORS (extended)  → code: ETN
    //   PRIMARY_VENDORS     → code: CHD
    // The seed data ships with both; primary must win.
    const map = await buildReverseVendorMap();
    expect(map.get("eaton")).toBe("CHD");
  });

  it("resolves 'cutler hammer' to the primary code CHD, not the extended code ETN", async () => {
    // 'cutler hammer' appears in both VENDORS (ETN) and PRIMARY_VENDORS (CHD).
    const map = await buildReverseVendorMap();
    expect(map.get("cutler hammer")).toBe("CHD");
  });

  it("resolves 'cutler-hammer' to the primary code CHD", async () => {
    const map = await buildReverseVendorMap();
    expect(map.get("cutler-hammer")).toBe("CHD");
  });

  it("extended-only names still resolve to the extended code", async () => {
    // 'westinghouse' only appears in VENDORS (ETN), not in PRIMARY_VENDORS.
    const map = await buildReverseVendorMap();
    expect(map.get("westinghouse")).toBe("ETN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// seedVendors — isPrimary preservation
// ─────────────────────────────────────────────────────────────────────────────

describe("seedVendors — preserves is_primary = true on all primary entries", () => {
  beforeAll(async () => {
    await seedVendors();
  });

  it("all PRIMARY_VENDORS entries exist in the DB with isPrimary = true", async () => {
    const rows = await db
      .select()
      .from(vendorMapTable)
      .where(eq(vendorMapTable.isPrimary, true));

    const primaryCodesInDb = new Set(rows.map((r) => r.code));

    for (const entry of PRIMARY_VENDORS) {
      expect(primaryCodesInDb.has(entry.code)).toBe(true);
    }

    // Must have at least as many primary rows as PRIMARY_VENDORS (may have more
    // if extra synthetic primaries exist during parallel test runs, but all
    // canonical 68 must be present).
    expect(primaryCodesInDb.size).toBeGreaterThanOrEqual(PRIMARY_VENDORS.length);
  });

  it("re-running seedVendors restores isPrimary = true after a row was corrupted", async () => {
    // Pick any primary vendor and corrupt its flag
    const target = PRIMARY_VENDORS[0];
    await db
      .update(vendorMapTable)
      .set({ isPrimary: false })
      .where(eq(vendorMapTable.code, target.code));

    const corrupted = await db
      .select()
      .from(vendorMapTable)
      .where(eq(vendorMapTable.code, target.code));
    expect(corrupted[0]?.isPrimary).toBe(false);

    // Re-seed
    await seedVendors();

    const restored = await db
      .select()
      .from(vendorMapTable)
      .where(eq(vendorMapTable.code, target.code));
    expect(restored[0]?.isPrimary).toBe(true);
  });

  it("re-running seedVendors does not downgrade any primary entry to isPrimary = false", async () => {
    await seedVendors();

    const rows = await db
      .select()
      .from(vendorMapTable)
      .where(eq(vendorMapTable.isPrimary, true));

    const primaryCodes = new Set(rows.map((r) => r.code));
    for (const entry of PRIMARY_VENDORS) {
      expect(primaryCodes.has(entry.code)).toBe(true);
    }
  });
});
