/**
 * HTTP integration tests: POST /api/inventory/search filters by resolved vendor name.
 *
 * Design: all 12 test rows share a single unique description token
 * ("JESTVENDREGRESSIONMULTIVND").  Every row matches FTS equally, so when a
 * vendor filter is active the 50% confidence penalty applied by applyVendorBoost
 * to non-matching vendors drops every competitor below the 50% confidence
 * threshold — mathematically excluding them — while the matching vendor gets a
 * +0.15 boost and survives.  The vendor filter (resolved from the human-readable
 * name → code) is therefore the ONLY factor that determines which items appear.
 *
 * Per vendor the test asserts:
 *   1. The target JEST row is present in results.
 *   2. JEST rows for all other vendors are absent from results.
 *   3. Every result item's `vendor` field equals the resolved code.
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
import supertest from "supertest";
import { sql } from "drizzle-orm";
import { db, inventoryTable } from "@workspace/db";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Prefix for all JEST fixture rows in this suite (used for cleanup). */
const JEST_VNR_PREFIX = "JEST-VNR-";

/**
 * Shared nonsense token embedded in every fixture row's description.
 * It cannot appear in any production row, so any result that contains this
 * token in its description is definitively a fixture row from this suite.
 * Using one token across all 12 vendors means FTS matches ALL rows equally —
 * vendor filtering is the only constraint that separates them.
 */
const SHARED_DESCRIPTION_TOKEN = "JESTVENDREGRESSIONMULTIVND";

/**
 * Vendor/code pairs under test.  Each entry:
 *   - code:       the expected vendor code stored in the `vendor` DB column
 *   - vendorName: the human-readable name sent in the `vendor` search field
 *   - catalog:    unique catalog string for the fixture row (JEST-VNR-* prefix)
 */
const VENDOR_PAIRS: Array<{ code: string; vendorName: string; catalog: string }> = [
  { code: "CRS", vendorName: "CROUSE-HINDS",     catalog: "JEST-VNR-CRS-MV01" },
  { code: "SQD", vendorName: "SQUARE D",         catalog: "JEST-VNR-SQD-MV01" },
  { code: "CHD", vendorName: "EATON",            catalog: "JEST-VNR-CHD-MV01" },
  { code: "HBL", vendorName: "HUBBELL",          catalog: "JEST-VNR-HBL-MV01" },
  { code: "LEV", vendorName: "LEVITON",          catalog: "JEST-VNR-LEV-MV01" },
  { code: "SIE", vendorName: "SIEMENS",          catalog: "JEST-VNR-SIE-MV01" },
  { code: "KLE", vendorName: "KLEIN TOOLS",      catalog: "JEST-VNR-KLE-MV01" },
  { code: "MIL", vendorName: "MILWAUKEE",        catalog: "JEST-VNR-MIL-MV01" },
  { code: "LUT", vendorName: "LUTRON",           catalog: "JEST-VNR-LUT-MV01" },
  { code: "PAS", vendorName: "PASS & SEYMOUR",   catalog: "JEST-VNR-PAS-MV01" },
  { code: "IDE", vendorName: "IDEAL INDUSTRIES", catalog: "JEST-VNR-IDE-MV01" },
  { code: "GRD", vendorName: "GREENLEE",         catalog: "JEST-VNR-GRD-MV01" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanupVnrRows(): Promise<void> {
  await db
    .delete(inventoryTable)
    .where(sql`${inventoryTable.catalog} LIKE ${JEST_VNR_PREFIX + "%"}`);
}

/** Insert all 12 fixture rows with the shared description token. */
async function insertAllFixtureRows(): Promise<void> {
  for (const pair of VENDOR_PAIRS) {
    await db
      .insert(inventoryTable)
      .values({
        vendor: pair.code,
        catalog: pair.catalog,
        description: `${SHARED_DESCRIPTION_TOKEN} fixture for code ${pair.code}`,
        binLocations: [] as Array<string>,
        aiKeywords: [] as Array<string>,
      })
      .onConflictDoNothing();
  }
}

/**
 * Search the inventory with the shared description token + a specific vendor name.
 * Because every fixture row matches FTS equally on the shared token, the vendor
 * filter (resolved from vendorName → code) is the deciding constraint.
 */
async function searchWithVendorName(vendorName: string) {
  const res = await supertest(app)
    .post("/api/inventory/search")
    .send({ keywords: SHARED_DESCRIPTION_TOKEN, vendor: vendorName })
    .expect(200);
  return res.body.results as Array<{ item: { vendor: string; catalog: string; description: string } }>;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TEST_USER_ID;
  await cleanupVnrRows();
  await insertAllFixtureRows();
}, 30_000);

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  await cleanupVnrRows();
}, 10_000);

// ── Per-vendor HTTP tests ─────────────────────────────────────────────────────
//
// All 12 fixture rows are present before every test.  The shared FTS token
// ensures all 12 match by keyword; the vendor filter is the only discriminator.
//
// applyVendorBoost semantics (scoreHelpers.ts):
//   - Matching vendor:     confidence + 0.15  (stays above 50% threshold)
//   - Non-matching vendor: confidence × 0.50  (falls below 50% threshold)
// Because initial confidence cannot exceed 1.0, the maximum penalised
// confidence is 0.5 — which does NOT pass the > 0.5 threshold.  Non-matching
// fixture rows are therefore excluded from results with mathematical certainty.

describe("POST /api/inventory/search — vendor name filter is the deciding constraint", () => {
  for (const pair of VENDOR_PAIRS) {
    describe(`vendor '${pair.vendorName}' → code '${pair.code}'`, () => {
      let results: Array<{ item: { vendor: string; catalog: string; description: string } }>;

      beforeEach(async () => {
        results = await searchWithVendorName(pair.vendorName);
      }, 10_000);

      it(
        "the fixture row for this vendor appears in results",
        () => {
          const match = results.find((r) => r.item.catalog === pair.catalog);
          expect(match).toBeDefined();
          expect(match!.item.vendor).toBe(pair.code);
        },
        10_000,
      );

      it(
        "fixture rows for OTHER vendors are absent (vendor filter excludes them via 50% confidence penalty)",
        () => {
          // Isolate JEST-VNR fixture rows that belong to a DIFFERENT vendor.
          // These rows matched FTS equally but must be penalised below threshold.
          const otherJestCatalogs = VENDOR_PAIRS
            .filter((p) => p.code !== pair.code)
            .map((p) => p.catalog);

          const leaked = results
            .filter((r) => otherJestCatalogs.includes(r.item.catalog))
            .map((r) => ({ catalog: r.item.catalog, vendor: r.item.vendor }));

          expect(leaked).toEqual([]);
        },
        10_000,
      );

      it(
        "every returned item has vendor = resolved code (no cross-vendor bleed)",
        () => {
          for (const r of results) {
            expect({
              catalog: r.item.catalog,
              vendor: r.item.vendor,
              expectedCode: pair.code,
            }).toEqual({
              catalog: r.item.catalog,
              vendor: pair.code,
              expectedCode: pair.code,
            });
          }
        },
        10_000,
      );
    });
  }
});
