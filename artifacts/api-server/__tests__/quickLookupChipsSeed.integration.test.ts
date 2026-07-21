/**
 * Integration test: seedQuickLookupChips() writes all 12 chip rows to the DB.
 *
 * OpenAI is mocked — no live API key or network access needed.
 * The real test DB is used (quick_lookup_cache table must exist).
 * The test is idempotent: seeded rows are deleted in beforeAll/afterAll.
 */

const mockCreate = jest.fn();

// The seed now goes through the aiProvider abstraction (Poe-backed), not the
// openai package directly — mock it so no real network calls are made.
jest.mock("../src/lib/aiProvider", () => ({
  getAiClient: () => ({ chat: { completions: { create: mockCreate } } }),
  getEnrichModel: () => "mock-enrich-model",
  getIdentifyModel: () => "mock-identify-model",
}));

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: mockCreate } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

process.env.LOG_LEVEL = "silent";

import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { seedQuickLookupChips } from "../src/seed/quickLookupChips";

/** The exact 12 labels defined in quickLookupChips.ts */
const EXPECTED_LABELS = [
  "1G",
  "GFCI",
  "AFCI",
  "TRWR",
  "Decora",
  "Romex",
  "MC Cable",
  "EMT",
  "Toggle vs Rocker",
  "Duplex",
  "15A vs 20A",
  "AWG",
];

async function ensureQuickLookupTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quick_lookup_cache (
      label TEXT PRIMARY KEY,
      answer TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function deleteChipRows() {
  for (const label of EXPECTED_LABELS) {
    await db.execute(
      sql`DELETE FROM quick_lookup_cache WHERE label = ${label}`
    );
  }
}

/** Return a minimal async-iterable stream yielding one content chunk. */
function makeStream(content: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content } }] };
    },
  };
}

beforeAll(async () => {
  await ensureQuickLookupTable();
  await deleteChipRows();
});

afterAll(async () => {
  await deleteChipRows();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Return a deterministic answer for every chip call
  mockCreate.mockResolvedValue(makeStream("Mocked chip answer."));
});

describe("seedQuickLookupChips()", () => {
  it("inserts exactly 12 rows into quick_lookup_cache", async () => {
    await seedQuickLookupChips();

    const rows = await db
      .select({ label: quickLookupCacheTable.label })
      .from(quickLookupCacheTable)
      .where(
        sql`${quickLookupCacheTable.label} = ANY(${sql.raw(
          `ARRAY[${EXPECTED_LABELS.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")}]`
        )})`
      );

    expect(rows).toHaveLength(12);
  });

  it("stores the mocked answer for each chip label", async () => {
    await seedQuickLookupChips();

    const rows = await db.select().from(quickLookupCacheTable).where(
      sql`${quickLookupCacheTable.label} = ANY(${sql.raw(
        `ARRAY[${EXPECTED_LABELS.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")}]`
      )})`
    );

    for (const row of rows) {
      expect(row.answer).toBe("Mocked chip answer.");
    }
  });

  it("each expected label is present in the database", async () => {
    await seedQuickLookupChips();

    const rows = await db.select({ label: quickLookupCacheTable.label }).from(quickLookupCacheTable).where(
      sql`${quickLookupCacheTable.label} = ANY(${sql.raw(
        `ARRAY[${EXPECTED_LABELS.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")}]`
      )})`
    );

    const presentLabels = new Set(rows.map((r) => r.label));
    for (const label of EXPECTED_LABELS) {
      expect(presentLabels.has(label)).toBe(true);
    }
  });

  it("is idempotent — running twice still leaves exactly 12 rows (upsert, no duplicates)", async () => {
    await seedQuickLookupChips();
    await seedQuickLookupChips();

    const rows = await db.select({ label: quickLookupCacheTable.label }).from(quickLookupCacheTable).where(
      sql`${quickLookupCacheTable.label} = ANY(${sql.raw(
        `ARRAY[${EXPECTED_LABELS.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")}]`
      )})`
    );

    expect(rows).toHaveLength(12);
  });

  it("calls the AI exactly once per chip (12 total)", async () => {
    await seedQuickLookupChips();

    expect(mockCreate).toHaveBeenCalledTimes(12);
  });
});
