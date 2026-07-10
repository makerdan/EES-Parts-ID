/**
 * Integration tests for the admin inventory edit PATCH routes.
 *
 * Routes covered:
 *   PATCH /inventory/:id/photo        — upload, remove, validation, GCS error, Zod guard, size limit
 *   PATCH /inventory/:id/description  — 500-char limit, type validation, 404
 *   PATCH /inventory/:id/bins         — normalization (trim/dedup/drop-empty), validation, 404
 *   PATCH /inventory/:id/dimensions   — partial update, validation (negative/overlimit/non-numeric), 404
 *   PATCH /inventory/:id/keywords     — validation, 404
 *
 * Mock strategy: identical to inventoryWriteZodGuards.test.ts — all
 * workspace dependencies (db, auth, objectStorage, answerCache, openai) are
 * stubbed so the tests run fully in-process without touching the network or
 * the database.  Two additional mocks are added for the photo route:
 *   • ../utils/imageResize  (resizeImages)
 *   • ../utils/aiHelpers    (estimateImageBytes)
 */

// ── Insert-chain mocks ─────────────────────────────────────────────────────────
const mockInsertReturning = jest.fn();
const mockInsertOnConflictDoUpdate = jest.fn(() => ({ returning: mockInsertReturning }));
const mockInsertValues = jest.fn(() => ({ onConflictDoUpdate: mockInsertOnConflictDoUpdate }));
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

// ── Update-chain mocks ─────────────────────────────────────────────────────────
const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

// ── Select-chain mocks ─────────────────────────────────────────────────────────
const mockSelectWhere = jest.fn();
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    update: mockUpdate,
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

jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

jest.mock("../utils/generateKeywords", () => ({
  generateKeywords: jest.fn().mockResolvedValue(["keyword1"]),
  mergeWithPinned: jest.fn((_a: string[], _b: string[]) => ["keyword1"]),
}));

jest.mock("../utils/imageResize", () => ({
  resizeImages: jest.fn(),
}));

jest.mock("../utils/aiHelpers", () => ({
  estimateImageBytes: jest.fn(),
}));

// ── Imports ────────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { uploadCatalogImage } from "../lib/objectStorage";
import { resizeImages } from "../utils/imageResize";
import { estimateImageBytes } from "../utils/aiHelpers";
import app from "../app";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

const SMALL_BASE64 = Buffer.alloc(16).toString("base64");

beforeEach(() => {
  jest.clearAllMocks();

  // Restore insert chain
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockInsertOnConflictDoUpdate });
  mockInsertOnConflictDoUpdate.mockReturnValue({ returning: mockInsertReturning });
  mockInsertReturning.mockResolvedValue([{ isNew: false }]);

  // Restore update chain
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
  mockUpdateReturning.mockResolvedValue([makeWellFormedRow()]);

  // Restore select chain
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelectWhere.mockResolvedValue([]);

  // Photo route defaults
  (resizeImages as jest.Mock).mockResolvedValue({
    fullBuffer: Buffer.alloc(1),
    thumbnailBuffer: Buffer.alloc(1),
  });
  (estimateImageBytes as jest.Mock).mockReturnValue(1024); // 1 KB — well within limit
  (uploadCatalogImage as jest.Mock).mockResolvedValue("https://gcs.example.com/img.jpg");
});

// =============================================================================
// PATCH /inventory/:id/photo
// =============================================================================

describe("PATCH /api/inventory/42/photo — upload slot 1", () => {
  it("returns 200 with imageUrl set when GCS upload succeeds", async () => {
    const fullUrl = "https://gcs.example.com/full.jpg";
    const thumbUrl = "https://gcs.example.com/thumb.jpg";
    (uploadCatalogImage as jest.Mock)
      .mockResolvedValueOnce(fullUrl)
      .mockResolvedValueOnce(thumbUrl);
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ imageUrl: fullUrl, thumbnailUrl: thumbUrl }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ imageBase64: SMALL_BASE64, mimeType: "image/jpeg", slot: 1 });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBe(fullUrl);
    expect(res.body.thumbnailUrl).toBe(thumbUrl);
    expect(res.body.imageUrl2).toBeNull();
  });
});

describe("PATCH /api/inventory/42/photo — upload slot 2", () => {
  it("returns 200 with imageUrl2 set when GCS upload succeeds for slot 2", async () => {
    const full2 = "https://gcs.example.com/full2.jpg";
    const thumb2 = "https://gcs.example.com/thumb2.jpg";
    (uploadCatalogImage as jest.Mock)
      .mockResolvedValueOnce(full2)
      .mockResolvedValueOnce(thumb2);
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ imageUrl2: full2, thumbnailUrl2: thumb2 }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ imageBase64: SMALL_BASE64, mimeType: "image/jpeg", slot: 2 });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl2).toBe(full2);
    expect(res.body.thumbnailUrl2).toBe(thumb2);
    expect(res.body.imageUrl).toBeNull();
  });
});

describe("PATCH /api/inventory/42/photo — remove slot 1", () => {
  it("returns 200 with null imageUrl/thumbnailUrl when remove:true slot:1", async () => {
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ imageUrl: null, thumbnailUrl: null }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ remove: true, slot: 1 });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeNull();
    expect(res.body.thumbnailUrl).toBeNull();
  });
});

describe("PATCH /api/inventory/42/photo — remove slot 2", () => {
  it("returns 200 with null imageUrl2/thumbnailUrl2 when remove:true slot:2", async () => {
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ imageUrl2: null, thumbnailUrl2: null }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ remove: true, slot: 2 });

    expect(res.status).toBe(200);
    expect(res.body.imageUrl2).toBeNull();
    expect(res.body.thumbnailUrl2).toBeNull();
  });
});

describe("PATCH /api/inventory/42/photo — validation errors", () => {
  it("returns 400 when imageBase64 is missing and not a remove op", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ mimeType: "image/jpeg", slot: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imageBase64/i);
  });

  it("returns 400 when imageBase64 is empty string and not a remove op", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ imageBase64: "   ", mimeType: "image/jpeg", slot: 1 });

    expect(res.status).toBe(400);
  });

  it("returns 400 when item id is 0 (falsy)", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/0/photo")
      .send({ remove: true, slot: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid item/i);
  });

  it("returns 413 when estimateImageBytes exceeds 10 MB", async () => {
    (estimateImageBytes as jest.Mock).mockReturnValue(11 * 1024 * 1024);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ imageBase64: SMALL_BASE64, mimeType: "image/jpeg", slot: 1 });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/10 mb/i);
  });
});

describe("PATCH /api/inventory/42/photo — not found", () => {
  it("returns 404 when DB returning() is empty", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ remove: true, slot: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("PATCH /api/inventory/42/photo — server errors", () => {
  it("returns 500 when uploadCatalogImage throws", async () => {
    (uploadCatalogImage as jest.Mock).mockRejectedValue(new Error("GCS unavailable"));

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ imageBase64: SMALL_BASE64, mimeType: "image/jpeg", slot: 1 });

    expect(res.status).toBe(500);
  });

  it("returns 500 (Zod guard) when DB row has non-string imageUrl", async () => {
    const row = makeWellFormedRow({});
    (row as Record<string, unknown>)["imageUrl"] = 42; // invalid — schema expects string | null
    mockUpdateReturning.mockResolvedValue([row]);

    const res = await supertest(app)
      .patch("/api/inventory/42/photo")
      .send({ remove: true, slot: 1 });

    expect(res.status).toBe(500);
  });
});

// =============================================================================
// PATCH /inventory/:id/description
// =============================================================================

describe("PATCH /api/inventory/42/description — valid inputs", () => {
  it("returns 200 for a 500-character description (at the limit)", async () => {
    const description = "x".repeat(500);
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ description })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe(description);
  });

  it("returns 200 for an empty string (clears the description)", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ description: "" })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "" });

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/inventory/42/description — validation errors", () => {
  it("returns 400 for a 501-character description (over the limit)", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500 characters/i);
  });

  it("returns 400 when description is absent from body", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });

  it("returns 400 when description is a number", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
  });
});

describe("PATCH /api/inventory/42/description — not found", () => {
  it("returns 404 when DB returning() is empty", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await supertest(app)
      .patch("/api/inventory/42/description")
      .send({ description: "hello" });

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// PATCH /inventory/:id/bins
// =============================================================================

describe("PATCH /api/inventory/42/bins — normalization", () => {
  it("deduplicates case-insensitively, preserving first-occurrence casing", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ binLocations: ["A1", "B2"] })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["A1", "a1", "B2"] });

    expect(res.status).toBe(200);
    expect((mockUpdateSet.mock.calls[0] as unknown[])[0]).toMatchObject({ binLocations: ["A1", "B2"] });
    expect(res.body.binLocations).toEqual(["A1", "B2"]);
  });

  it("trims whitespace from each entry", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ binLocations: ["A1", "B2"] })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["  A1  ", "B2  "] });

    expect(res.status).toBe(200);
    expect((mockUpdateSet.mock.calls[0] as unknown[])[0]).toMatchObject({ binLocations: ["A1", "B2"] });
  });

  it("drops empty and whitespace-only strings", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ binLocations: ["B2"] })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["", " ", "B2"] });

    expect(res.status).toBe(200);
    expect((mockUpdateSet.mock.calls[0] as unknown[])[0]).toMatchObject({ binLocations: ["B2"] });
  });

  it("accepts an empty array and stores it", async () => {
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ binLocations: [] })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: [] });

    expect(res.status).toBe(200);
    expect(res.body.binLocations).toEqual([]);
  });
});

describe("PATCH /api/inventory/42/bins — validation errors", () => {
  it("returns 400 when binLocations is not an array", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: "A1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  it("returns 400 when an array element is a number", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: [42] });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/inventory/42/bins — not found", () => {
  it("returns 404 when DB returning() is empty", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await supertest(app)
      .patch("/api/inventory/42/bins")
      .send({ binLocations: ["A1"] });

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// PATCH /inventory/:id/dimensions
// =============================================================================

describe("PATCH /api/inventory/42/dimensions — valid inputs", () => {
  it("returns 200 for a partial update (only length); preserves other fields from DB", async () => {
    const dbDims = { length: 50, width: 30, height: null, diameter: null };
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ dimensions: dbDims })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 50 });

    expect(res.status).toBe(200);
    expect(res.body.dimensions.length).toBe(50);
    expect(res.body.dimensions.width).toBe(30); // preserved by DB (mocked)
  });

  it("returns 200 when null is used to clear a field", async () => {
    const dbDims = { length: null, width: null, height: null, diameter: null };
    mockUpdateReturning.mockResolvedValue([makeWellFormedRow({ dimensions: dbDims })]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: null });

    expect(res.status).toBe(200);
    expect(res.body.dimensions.length).toBeNull();
  });
});

describe("PATCH /api/inventory/42/dimensions — validation errors", () => {
  it("returns 400 for a negative length value", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative/i);
  });

  it("returns 400 for a value above 100,000", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 100001 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative/i);
  });

  it("returns 400 for a non-numeric string value", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: "abc" });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/inventory/42/dimensions — not found", () => {
  it("returns 404 when DB returning() is empty", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await supertest(app)
      .patch("/api/inventory/42/dimensions")
      .send({ length: 50 });

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// PATCH /inventory/:id/keywords
// =============================================================================

describe("PATCH /api/inventory/42/keywords — validation errors", () => {
  it("returns 400 when keywords is not an array", async () => {
    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: "widget" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });
});

describe("PATCH /api/inventory/42/keywords — not found", () => {
  it("returns 404 when DB returning() is empty", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: ["widget"] });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/inventory/42/keywords — success", () => {
  it("returns 200 with updated keywords array", async () => {
    mockUpdateReturning.mockResolvedValue([
      makeWellFormedRow({ aiKeywords: ["motor", "ac"] }),
    ]);

    const res = await supertest(app)
      .patch("/api/inventory/42/keywords")
      .send({ keywords: ["motor", "ac"] });

    expect(res.status).toBe(200);
    expect(res.body.aiKeywords).toEqual(["motor", "ac"]);
  });
});
