/**
 * Unit tests for Zod output guards on inventory write routes.
 *
 * Routes covered (each already has a .parse() guard; these tests verify it
 * actually fires and blocks broken DB responses):
 *
 *   PATCH /inventory/:id/barcodes   → UpdateItemBarcodesResponse
 *   PATCH /inventory/:id/bins       → UpdateItemBinsResponse
 *   PATCH /inventory/:id/description → UpdateItemDescriptionResponse
 *   PATCH /inventory/:id/enrich     → ReenrichItemResponse
 *   PATCH /inventory/:id/keywords   → UpdateItemKeywordsResponse
 *   PATCH /inventory/:id/dimensions → UpdateItemDimensionsResponse
 *   GET   /inventory/barcode/:code  → LookupByBarcodeResponse
 *   POST  /inventory/upsert-batch/preview → UpsertBatchPreviewResponse (schema-level)
 *
 * Two test layers per route:
 *   1. Route-level: supertest against the Express app with a mocked DB that
 *      returns a row missing a required field → expect 500 (guard fired).
 *      A well-formed row → expect success status.
 *   2. Schema-level: .parse() called directly to pin exact Zod behaviour.
 */

// ── Insert-chain mocks: db.insert(table).values({}).onConflictDoUpdate({}).returning({}) ──
const mockInsertReturning = jest.fn();
const mockInsertOnConflictDoUpdate = jest.fn(() => ({ returning: mockInsertReturning }));
const mockInsertValues = jest.fn(() => ({ onConflictDoUpdate: mockInsertOnConflictDoUpdate }));
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

// ── Update-chain mocks: db.update(table).set({}).where(...).returning() ───────
const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

// ── Select-chain mocks ────────────────────────────────────────────────────────
// Supports two endings:
//   db.select().from(table).where(cond).limit(n)     → mockSelectLimit returns Promise<row[]>
//   db.select({...}).from(table).where(cond)          → mockSelectWhere returns Promise<row[]>
const mockSelectLimit = jest.fn();
const mockSelectWhere = jest.fn();
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    update: mockUpdate,
    // Fire-and-forget ANALYZE call in upsert-batch; must exist or throws synchronously.
    execute: jest.fn().mockResolvedValue(undefined),
  },
  inventoryTable: {},
  usersTable: {},
  misspellingMapTable: {},
  vendorMapTable: {},
  synonymMapTable: {},
  electricalSlangMapTable: {},
  measureEnrichJobTable: {},
  inventoryFtsVector: {},
  abbreviationMapTable: {},
  collectKeywords: jest.fn(() => []),
  findNodeBySlug: jest.fn(),
  getAllTaxonomyKeywords: jest.fn(() => []),
  TAXONOMY: [],
}));

// ── OpenAI / AI mocks ─────────────────────────────────────────────────────────
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

// ── Auth middleware mocks ─────────────────────────────────────────────────────
jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Answer cache mock ─────────────────────────────────────────────────────────
jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Object storage mock ───────────────────────────────────────────────────────
jest.mock("../lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── generateKeywords / mergeWithPinned mocks (used by enrich route) ───────────
jest.mock("../utils/generateKeywords", () => ({
  generateKeywords: jest.fn().mockResolvedValue(["keyword1", "keyword2"]),
  mergeWithPinned: jest.fn((_ai: string[], _pinned: string[]) => ["keyword1", "keyword2"]),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../app";
import {
  LookupByBarcodeResponse,
  ReenrichItemResponse,
  UpdateItemBarcodesResponse,
  UpdateItemBinsResponse,
  UpdateItemDescriptionResponse,
  UpdateItemDimensionsResponse,
  UpdateItemKeywordsResponse,
  UpsertBatchPreviewResponse,
} from "@workspace/api-zod";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A complete, well-formed inventory row that satisfies every *Response schema. */
function makeWellFormedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    vendor: "ACME",
    catalog: "W-999",
    description: "Test widget",
    binLocations: ["A1"],
    aiKeywords: ["widget"],
    barcodes: ["012345678901"],
    enrichedAt: null,
    imageUrl: null,
    thumbnailUrl: null,
    imageUrl2: null,
    thumbnailUrl2: null,
    expandedDescription: null,
    dimensions: null,
    pinnedKeywords: [],
    createdAt: new Date("2025-06-01T00:00:00Z"),
    updatedAt: new Date("2025-06-01T00:00:00Z"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Global beforeEach: restore all mock chains that clearAllMocks() wipes.
// ─────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();

  // Restore insert chain (default: returning resolves to [{ isNew: false }])
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockInsertOnConflictDoUpdate });
  mockInsertOnConflictDoUpdate.mockReturnValue({ returning: mockInsertReturning });
  mockInsertReturning.mockResolvedValue([{ isNew: false }]);

  // Restore update chain
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });

  // Restore select chain (default: where() resolves to [] for preview route)
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelectWhere.mockResolvedValue([]);
  mockSelectLimit.mockResolvedValue([]);
});

// =============================================================================
// PATCH /inventory/:id/barcodes  →  UpdateItemBarcodesResponse
// =============================================================================

describe("PATCH /api/inventory/42/barcodes — malformed DB row triggers 500", () => {
  it("returns 500 when updated row is missing createdAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/barcodes")
      .send({ barcodes: ["ABC123"] });

    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("createdAt");
  });

  it("returns 500 when updated row is missing id", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["id"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/barcodes")
      .send({ barcodes: ["ABC123"] });

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/barcodes — well-formed DB row returns 200", () => {
  it("returns 200 with full item when DB row is valid", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .patch("/api/inventory/42/barcodes")
      .send({ barcodes: ["ABC123"] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("vendor", "ACME");
    expect(res.body).toHaveProperty("barcodes");
    expect(typeof res.body.createdAt).toBe("string");
  });

  it("strips extra fields not in schema (pinnedKeywords must not leak)", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ pinnedKeywords: ["secret"] })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/barcodes")
      .send({ barcodes: ["ABC123"] })
      .expect(200);

    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// PATCH /inventory/:id/bins  →  UpdateItemBinsResponse
// =============================================================================

describe("PATCH /api/inventory/42/bins — malformed DB row triggers 500", () => {
  it("returns 500 when updated row is missing updatedAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["updatedAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["B2"] });

    expect(res.status).toBe(500);
  });

  it("returns 500 when updated row is missing vendor", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["vendor"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["B2"] });

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/bins — well-formed DB row returns 200", () => {
  it("returns 200 with full item", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["B2"] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("binLocations");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// PATCH /inventory/:id/description  →  UpdateItemDescriptionResponse
// =============================================================================

describe("PATCH /api/inventory/42/description — malformed DB row triggers 500", () => {
  it("returns 500 when updated row is missing createdAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "New description" });

    expect(res.status).toBe(500);
  });

  it("returns 500 when updated row is missing catalog", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["catalog"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "New description" });

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/description — well-formed DB row returns 200", () => {
  it("returns 200 with full item", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "New description" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("description");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// PATCH /inventory/:id/keywords  →  UpdateItemKeywordsResponse
// =============================================================================

describe("PATCH /api/inventory/42/keywords — malformed DB row triggers 500", () => {
  it("returns 500 when updated row is missing updatedAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["updatedAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: ["relay", "contactor"] });

    expect(res.status).toBe(500);
  });

  it("returns 500 when updated row is missing id", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["id"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: ["relay"] });

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/keywords — well-formed DB row returns 200", () => {
  it("returns 200 with full item and strips pinnedKeywords", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: ["relay", "contactor"] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("aiKeywords");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// PATCH /inventory/:id/dimensions  →  UpdateItemDimensionsResponse
// =============================================================================

describe("PATCH /api/inventory/42/dimensions — malformed DB row triggers 500", () => {
  it("returns 500 when updated row is missing createdAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 50, width: 30 });

    expect(res.status).toBe(500);
  });

  it("returns 500 when updated row is missing vendor", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["vendor"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 50 });

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/dimensions — well-formed DB row returns 200", () => {
  it("returns 200 with full item", async () => {
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ dimensions: { length: 50, width: 30, height: null, diameter: null } }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 50, width: 30 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("dimensions");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// PATCH /inventory/:id/enrich  →  ReenrichItemResponse
// The enrich route first SELECTs the item, then calls generateKeywords, then UPDATEs.
// =============================================================================

describe("PATCH /api/inventory/42/enrich — malformed DB row triggers 500", () => {
  beforeEach(() => {
    // First select (fetch item to enrich) returns a well-formed row.
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([makeWellFormedRow()]);
  });

  it("returns 500 when the updated row (from returning()) is missing createdAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app).patch("/api/inventory/42/enrich");

    expect(res.status).toBe(500);
  });

  it("returns 500 when the updated row is missing id", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["id"];
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app).patch("/api/inventory/42/enrich");

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/inventory/42/enrich — well-formed DB row returns 200", () => {
  it("returns 200 with full item and strips pinnedKeywords", async () => {
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([makeWellFormedRow()]);
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ aiKeywords: ["keyword1", "keyword2"] })]);

    const res = await supertest(app).patch("/api/inventory/42/enrich");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("aiKeywords");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// GET /inventory/barcode/:code  →  LookupByBarcodeResponse
// =============================================================================

describe("GET /api/inventory/barcode/ABC-123 — malformed DB row triggers 500", () => {
  it("returns 500 when fetched row is missing createdAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([row]);

    const res = await supertest(app).get("/api/inventory/barcode/ABC-123");

    expect(res.status).toBe(500);
  });

  it("returns 500 when fetched row is missing updatedAt", async () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["updatedAt"];
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([row]);

    const res = await supertest(app).get("/api/inventory/barcode/ABC-123");

    expect(res.status).toBe(500);
  });
});

describe("GET /api/inventory/barcode/ABC-123 — well-formed DB row returns 200", () => {
  it("returns 200 with full item and strips pinnedKeywords", async () => {
    mockSelectWhere.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app).get("/api/inventory/barcode/ABC-123");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 42);
    expect(res.body).toHaveProperty("vendor", "ACME");
    expect(typeof res.body.createdAt).toBe("string");
    expect(res.body).not.toHaveProperty("pinnedKeywords");
  });
});

// =============================================================================
// POST /inventory/upsert-batch/preview  →  UpsertBatchPreviewResponse
// The guard is on a computed object (not a raw DB row).
// =============================================================================

describe("POST /api/inventory/upsert-batch/preview — route-level: returns 200 with correct shape", () => {
  it("returns 200 with diff summary when items have no existing DB rows", async () => {
    // Default: mockSelectWhere resolves to [] (no existing rows)
    const res = await supertest(app)
      .post("/api/inventory/upsert-batch/preview")
      .send({
        items: [
          { vendor: "ACME", catalog: "W-001", binLocations: ["A1"] },
          { vendor: "ACME", catalog: "W-002" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("willReplaceBins");
    expect(res.body).toHaveProperty("willAddBins");
    expect(res.body).toHaveProperty("willPreserveBins");
    expect(res.body).toHaveProperty("noChange");
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});

// =============================================================================
// Schema-level tests: verify each Response schema rejects missing required fields
// =============================================================================

describe("UpdateItemBarcodesResponse schema", () => {
  it("throws when createdAt is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    expect(() => UpdateItemBarcodesResponse.parse(row)).toThrow();
  });

  it("throws when id is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["id"];
    expect(() => UpdateItemBarcodesResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => UpdateItemBarcodesResponse.parse(makeWellFormedRow())).not.toThrow();
  });

  it("strips extra fields (pinnedKeywords must not appear in output)", () => {
    const result = UpdateItemBarcodesResponse.parse(makeWellFormedRow({ pinnedKeywords: ["secret"] }));
    expect(result).not.toHaveProperty("pinnedKeywords");
  });
});

describe("UpdateItemBinsResponse schema", () => {
  it("throws when updatedAt is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["updatedAt"];
    expect(() => UpdateItemBinsResponse.parse(row)).toThrow();
  });

  it("throws when vendor is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["vendor"];
    expect(() => UpdateItemBinsResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => UpdateItemBinsResponse.parse(makeWellFormedRow())).not.toThrow();
  });
});

describe("UpdateItemDescriptionResponse schema", () => {
  it("throws when catalog is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["catalog"];
    expect(() => UpdateItemDescriptionResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => UpdateItemDescriptionResponse.parse(makeWellFormedRow())).not.toThrow();
  });
});

describe("ReenrichItemResponse schema", () => {
  it("throws when createdAt is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    expect(() => ReenrichItemResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => ReenrichItemResponse.parse(makeWellFormedRow())).not.toThrow();
  });

  it("strips extra fields (pinnedKeywords does not leak)", () => {
    const result = ReenrichItemResponse.parse(makeWellFormedRow({ pinnedKeywords: ["secret"] }));
    expect(result).not.toHaveProperty("pinnedKeywords");
  });
});

describe("UpdateItemKeywordsResponse schema", () => {
  it("throws when id is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["id"];
    expect(() => UpdateItemKeywordsResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => UpdateItemKeywordsResponse.parse(makeWellFormedRow())).not.toThrow();
  });
});

describe("UpdateItemDimensionsResponse schema", () => {
  it("throws when createdAt is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["createdAt"];
    expect(() => UpdateItemDimensionsResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row with null dimensions without throwing", () => {
    expect(() => UpdateItemDimensionsResponse.parse(makeWellFormedRow({ dimensions: null }))).not.toThrow();
  });

  it("parses a well-formed row with a dimensions object without throwing", () => {
    const row = makeWellFormedRow({
      dimensions: { length: 100, width: 50, height: null, diameter: null },
    });
    expect(() => UpdateItemDimensionsResponse.parse(row)).not.toThrow();
  });
});

describe("LookupByBarcodeResponse schema", () => {
  it("throws when updatedAt is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["updatedAt"];
    expect(() => LookupByBarcodeResponse.parse(row)).toThrow();
  });

  it("throws when description is absent", () => {
    const row = makeWellFormedRow();
    delete (row as Record<string, unknown>)["description"];
    expect(() => LookupByBarcodeResponse.parse(row)).toThrow();
  });

  it("parses a well-formed row without throwing", () => {
    expect(() => LookupByBarcodeResponse.parse(makeWellFormedRow())).not.toThrow();
  });

  it("strips pinnedKeywords from parsed output", () => {
    const result = LookupByBarcodeResponse.parse(makeWellFormedRow({ pinnedKeywords: ["x"] }));
    expect(result).not.toHaveProperty("pinnedKeywords");
  });
});

describe("UpsertBatchPreviewResponse schema", () => {
  it("throws when willReplaceBins is absent", () => {
    expect(() =>
      UpsertBatchPreviewResponse.parse({
        willAddBins: 1,
        willPreserveBins: 0,
        noChange: 0,
        rows: [],
      }),
    ).toThrow();
  });

  it("throws when a row has an invalid status enum", () => {
    expect(() =>
      UpsertBatchPreviewResponse.parse({
        willReplaceBins: 0,
        willAddBins: 0,
        willPreserveBins: 0,
        noChange: 1,
        rows: [
          {
            vendor: "ACME",
            catalog: "W-001",
            status: "INVALID_STATUS",
            existingBins: [],
            incomingBins: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("throws when counts are negative (nonnegative constraint)", () => {
    expect(() =>
      UpsertBatchPreviewResponse.parse({
        willReplaceBins: -1,
        willAddBins: 0,
        willPreserveBins: 0,
        noChange: 0,
        rows: [],
      }),
    ).toThrow();
  });

  it("parses a valid preview response without throwing", () => {
    expect(() =>
      UpsertBatchPreviewResponse.parse({
        willReplaceBins: 1,
        willAddBins: 0,
        willPreserveBins: 0,
        noChange: 0,
        rows: [
          {
            vendor: "ACME",
            catalog: "W-001",
            status: "replace",
            existingBins: ["A1"],
            incomingBins: ["B2"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("parses an empty rows array without throwing", () => {
    expect(() =>
      UpsertBatchPreviewResponse.parse({
        willReplaceBins: 0,
        willAddBins: 0,
        willPreserveBins: 0,
        noChange: 0,
        rows: [],
      }),
    ).not.toThrow();
  });
});

// =============================================================================
// POST /inventory/upsert-batch  — partial-failure / silent-gap guard
//
// The batch loop does individual DB inserts. If one row rejects or if the
// RETURNING clause comes back empty (silent schema-mismatch gap), the route
// must surface a 500 rather than returning inflated inserted/updated counts.
// =============================================================================

describe("POST /api/inventory/upsert-batch — DB insert rejects on one row → 500", () => {
  it("returns 500 when the DB insert throws for a row in the batch", async () => {
    // First call succeeds, second call rejects — simulates a mid-batch failure.
    mockInsertReturning
      .mockResolvedValueOnce([{ isNew: true }])
      .mockRejectedValueOnce(new Error("DB column does not exist"));

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({
        items: [
          { vendor: "ACME", catalog: "W-001" },
          { vendor: "ACME", catalog: "W-002" },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 500 when a single-item batch rejects", async () => {
    mockInsertReturning.mockRejectedValueOnce(new Error("relation does not exist"));

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({ items: [{ vendor: "ACME", catalog: "W-001" }] });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/inventory/upsert-batch — RETURNING empty array (silent gap) → 500", () => {
  it("returns 500 when the DB RETURNING clause yields no rows (schema mismatch scenario)", async () => {
    // An empty RETURNING result means the row was silently not written.
    // Without the guard this would have been counted as `updated` and returned
    // 200 with wrong counts — the silent data gap this task fixes.
    mockInsertReturning.mockResolvedValueOnce([]);

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({ items: [{ vendor: "ACME", catalog: "W-001" }] });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 500 when first row is fine but second returns empty array", async () => {
    mockInsertReturning
      .mockResolvedValueOnce([{ isNew: false }])
      .mockResolvedValueOnce([]);

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({
        items: [
          { vendor: "ACME", catalog: "W-001" },
          { vendor: "ACME", catalog: "W-002" },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/inventory/upsert-batch — happy path returns correct counts", () => {
  it("returns 200 with inserted+updated counts when all rows succeed", async () => {
    // Two inserts: first is new, second is an update.
    mockInsertReturning
      .mockResolvedValueOnce([{ isNew: true }])
      .mockResolvedValueOnce([{ isNew: false }]);

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({
        items: [
          { vendor: "ACME", catalog: "W-001", binLocations: ["A1"] },
          { vendor: "ACME", catalog: "W-002" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("inserted", 1);
    expect(res.body).toHaveProperty("updated", 1);
    expect(res.body).toHaveProperty("total", 2);
  });

  it("returns 200 with inserted=1 when a single new item is upserted", async () => {
    mockInsertReturning.mockResolvedValueOnce([{ isNew: true }]);

    const res = await supertest(app)
      .post("/api/inventory/upsert-batch")
      .send({ items: [{ vendor: "ACME", catalog: "W-NEW" }] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, updated: 0, total: 1 });
  });
});
