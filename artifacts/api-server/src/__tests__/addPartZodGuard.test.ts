/**
 * Unit tests for the Zod output guards on POST /api/inventory/add-part.
 *
 * Two layers of coverage:
 *
 * 1. Route-level: the add-part HTTP handler is called with a mocked DB that
 *    returns a row missing a required field.  The test asserts that the route
 *    returns 500 (the Zod parse threw and was caught) and NOT 201 with broken
 *    data.  A well-formed DB row asserts 201 { item: ... }.
 *
 * 2. Schema-level: AddPartResponse.parse() is called directly to confirm the
 *    exact fields that trigger/pass validation, independent of the HTTP layer.
 */

// ── DB mock — must be declared before any module imports ─────────────────────
// Chainable stubs for:
//   db.select().from(inventoryTable).where(...)   → existing-row check
//   db.insert(inventoryTable).values({}).returning()  → inserted row
//   db.delete(inventoryTable).where(...)           → rollback after 413
const mockWhere = jest.fn();
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

const mockReturning = jest.fn();
const mockValues = jest.fn(() => ({ returning: mockReturning }));
const mockInsert = jest.fn(() => ({ values: mockValues }));

const mockDeleteWhere = jest.fn().mockResolvedValue(undefined);
const mockDelete = jest.fn(() => ({ where: mockDeleteWhere }));

jest.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
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

// ── Auth middleware mocks — bypass Clerk + DB role lookup ─────────────────────
// requireAppAuth is mounted globally on /api in app.ts (before the router).
// requireAdminAuth is the per-route guard on this specific endpoint.
// Both are stubbed to call next() unconditionally so the Zod guard is the only
// thing under test.
jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Answer cache mock — invalidation fires-and-forgets; stub it out ───────────
jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Object storage mock ───────────────────────────────────────────────────────
jest.mock("../lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

// ── Image helpers mocks ────────────────────────────────────────────────────────
jest.mock("../utils/aiHelpers", () => ({
  ...(
    jest.requireActual("../../__tests__/helpers/aiHelpersMock") as typeof import("../../__tests__/helpers/aiHelpersMock")
  ).createAiHelpersMock(
    jest.requireActual("../utils/aiHelpers"),
    { estimateImageBytes: 1024 },
  ),
}));

jest.mock("../utils/imageResize", () => ({
  resizeImages: jest.fn().mockResolvedValue({
    fullBuffer: Buffer.alloc(1),
    thumbnailBuffer: Buffer.alloc(1),
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../app";
import { AddPartResponse, AddPartConflictResponse } from "@workspace/api-zod";
import { estimateImageBytes } from "../utils/aiHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A complete, well-formed inventory row that satisfies InventoryItemSchema. */
function makeWellFormedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    vendor: "ACME",
    catalog: "X-001",
    orderPurchase: 5,
    orderQuantity: 10,
    description: "Test part",
    binLocations: [],
    aiKeywords: [],
    barcodes: [],
    enrichedAt: null,
    imageUrl: null,
    thumbnailUrl: null,
    imageUrl2: null,
    thumbnailUrl2: null,
    expandedDescription: null,
    dimensions: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // Restore the drizzle chain stubs that clearAllMocks() resets.
  // clearAllMocks() clears mock.calls/results but also resets mockReturnValue /
  // mockResolvedValue set by previous tests, so re-apply them every time.
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ returning: mockReturning });
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
  mockDeleteWhere.mockResolvedValue(undefined);

  // Default: no existing row (not a duplicate), so the insert path runs.
  mockWhere.mockResolvedValue([]);

  // Default: estimateImageBytes returns a small value (well within 10 MB).
  (estimateImageBytes as jest.Mock).mockReturnValue(1024);
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 1: Route-level tests (HTTP handler + mocked DB)
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/inventory/add-part — route: malformed DB row triggers 500", () => {
  it("returns 500 (not 201) when the inserted row is missing createdAt", async () => {
    const malformedRow = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (malformedRow as any).createdAt;
    mockReturning.mockResolvedValue([malformedRow]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-001" });

    // The Zod parse must throw, surfacing as 500 — broken data must NOT reach
    // the client as a 201 success.
    expect(res.status).toBe(500);
    expect(res.status).not.toBe(201);
    // The broken item must not be in the response body.
    expect(res.body).not.toHaveProperty("item");
  });

  it("returns 500 (not 201) when the inserted row is missing updatedAt", async () => {
    const malformedRow = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (malformedRow as any).updatedAt;
    mockReturning.mockResolvedValue([malformedRow]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-002" });

    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("item");
  });

  it("returns 500 (not 201) when the inserted row is missing id", async () => {
    const malformedRow = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (malformedRow as any).id;
    mockReturning.mockResolvedValue([malformedRow]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-003" });

    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("item");
  });
});

describe("POST /api/inventory/add-part — route: well-formed DB row returns 201", () => {
  it("returns 201 with { item: ... } when the DB row satisfies the schema", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-001" })
      .expect(201);

    expect(res.body).toHaveProperty("item");
    expect(typeof res.body.item.id).toBe("number");
    expect(res.body.item.vendor).toBe("ACME");
    expect(res.body.item.catalog).toBe("X-001");
  });

  it("response item includes createdAt and updatedAt as ISO date strings", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow()]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-001" })
      .expect(201);

    expect(typeof res.body.item.createdAt).toBe("string");
    expect(typeof res.body.item.updatedAt).toBe("string");
    expect(new Date(res.body.item.createdAt).getFullYear()).toBe(2025);
  });

  it("Zod strips extra fields not in the schema — raw DB fields do not leak to the client", async () => {
    const rowWithExtra = { ...makeWellFormedRow(), internalDbOnlyField: "secret" };
    mockReturning.mockResolvedValue([rowWithExtra]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-001" })
      .expect(201);

    expect(res.body.item).not.toHaveProperty("internalDbOnlyField");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 2: Schema-level tests (AddPartResponse.parse called directly)
//
// These tests verify the exact Zod behaviour independent of the HTTP handler
// and are immune to content-type or serialization quirks in the test runner.
// ═════════════════════════════════════════════════════════════════════════════

describe("AddPartResponse schema — parse throws on malformed rows", () => {
  it("throws when createdAt is absent", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).createdAt;

    expect(() => AddPartResponse.parse({ item: row })).toThrow();
  });

  it("throws when updatedAt is absent", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).updatedAt;

    expect(() => AddPartResponse.parse({ item: row })).toThrow();
  });

  it("throws when id is absent", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).id;

    expect(() => AddPartResponse.parse({ item: row })).toThrow();
  });

  it("throws when vendor is absent", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).vendor;

    expect(() => AddPartResponse.parse({ item: row })).toThrow();
  });

  it("throws when catalog is absent", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).catalog;

    expect(() => AddPartResponse.parse({ item: row })).toThrow();
  });

  it("throws when the top-level item key is absent", () => {
    expect(() => AddPartResponse.parse({})).toThrow();
  });
});

describe("AddPartResponse schema — parse succeeds on well-formed rows", () => {
  it("parses a complete row without throwing", () => {
    expect(() => AddPartResponse.parse({ item: makeWellFormedRow() })).not.toThrow();
  });

  it("parsed result has the correct shape { item: { id, vendor, catalog, ... } }", () => {
    const result = AddPartResponse.parse({ item: makeWellFormedRow() });

    expect(result).toHaveProperty("item");
    expect(result.item.id).toBe(1);
    expect(result.item.vendor).toBe("ACME");
    expect(result.item.catalog).toBe("X-001");
    expect(result.item.createdAt).toBeInstanceOf(Date);
    expect(result.item.updatedAt).toBeInstanceOf(Date);
  });

  it("strips extra fields not in the schema (Zod strip mode)", () => {
    const rowWithExtra = { ...makeWellFormedRow(), secretInternalField: "should-be-gone" };
    const result = AddPartResponse.parse({ item: rowWithExtra });

    expect(result.item).not.toHaveProperty("secretInternalField");
  });

  it("accepts null for optional fields like enrichedAt, imageUrl, dimensions", () => {
    const row = makeWellFormedRow({ enrichedAt: null, imageUrl: null, dimensions: null });
    expect(() => AddPartResponse.parse({ item: row })).not.toThrow();
  });
});

describe("AddPartConflictResponse schema — parse throws on malformed rows", () => {
  it("throws when existingItem is missing createdAt", () => {
    const row = makeWellFormedRow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (row as any).createdAt;

    expect(() =>
      AddPartConflictResponse.parse({
        error: "Part already exists: ACME / X-001",
        existingItem: row,
      }),
    ).toThrow();
  });

  it("parses a valid conflict response without throwing", () => {
    expect(() =>
      AddPartConflictResponse.parse({
        error: "Part already exists: ACME / X-001",
        existingItem: makeWellFormedRow(),
      }),
    ).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 3: Input validation — field length and imageBase64 size guards
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/inventory/add-part — input validation: field lengths", () => {
  it("returns 400 when vendor exceeds 50 characters", async () => {
    const longVendor = "A".repeat(51);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: longVendor, catalog: "VALID-CATALOG" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vendor.*50|50.*vendor/i);
  });

  it("returns 400 when catalog exceeds 100 characters", async () => {
    const longCatalog = "C".repeat(101);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: longCatalog });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/catalog.*100|100.*catalog/i);
  });

  it("returns 400 when binLocation exceeds 200 characters", async () => {
    const longBin = "B".repeat(201);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "VALID-CAT", binLocation: longBin });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binLocation.*200|200.*binLocation/i);
  });

  it("accepts vendor of exactly 50 characters (at the limit)", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow({ vendor: "A".repeat(50) })]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "A".repeat(50), catalog: "VALID-CAT" });

    expect(res.status).toBe(201);
  });

  it("accepts catalog of exactly 100 characters (at the limit)", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow({ catalog: "C".repeat(100) })]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "C".repeat(100) });

    expect(res.status).toBe(201);
  });

  it("accepts binLocation of exactly 200 characters (at the limit)", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow({ binLocations: ["B".repeat(200)] })]);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "VALID-CAT", binLocation: "B".repeat(200) });

    expect(res.status).toBe(201);
  });
});

describe("POST /api/inventory/add-part — input validation: imageBase64 size guard", () => {
  it("returns 413 when imageBase64 payload exceeds 10 MB", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow()]);
    (estimateImageBytes as jest.Mock).mockReturnValue(11 * 1024 * 1024);

    const res = await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-IMG-001", imageBase64: "dGVzdA==" });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/10 mb/i);
  });

  it("413 response rolls back the inserted row (db.delete is called)", async () => {
    mockReturning.mockResolvedValue([makeWellFormedRow()]);
    (estimateImageBytes as jest.Mock).mockReturnValue(11 * 1024 * 1024);

    await supertest(app)
      .post("/api/inventory/add-part")
      .send({ vendor: "ACME", catalog: "X-IMG-002", imageBase64: "dGVzdA==" });

    expect(mockDelete).toHaveBeenCalled();
  });

});
