/**
 * Integration tests for HTTP 429 responses on rate-limited endpoints.
 *
 * Coverage:
 *   POST /api/inventory/search  — inventorySearchLimiter (60 req/min)
 *   POST /api/admin/query       — adminQueryLimiter      (20 req/min)
 *
 * Strategy: mock the rate limiter module so that `check()` returns a denied
 * result for the two new limiters, then assert the route returns 429 with a
 * numeric Retry-After header and a descriptive error body.  All other route
 * dependencies are mocked to avoid DB / AI infrastructure requirements.
 */

// ── Rate-limiter mock ─────────────────────────────────────────────────────────
// Must be declared before any imports so jest hoisting works correctly.
const mockInventorySearchCheck = jest.fn();
const mockAdminQueryCheck = jest.fn();

jest.mock("../lib/rateLimiter", () => ({
  identifyLimiter:       { check: jest.fn().mockResolvedValue({ allowed: true }) },
  translateLimiter:      { check: jest.fn().mockResolvedValue({ allowed: true }) },
  partCardLimiter:       { check: jest.fn().mockResolvedValue({ allowed: true }) },
  referenceAskLimiter:   { check: jest.fn().mockResolvedValue({ allowed: true }) },
  catalogPdfUploadLimiter: { check: jest.fn().mockResolvedValue({ allowed: true }) },
  inventorySearchLimiter: { check: mockInventorySearchCheck },
  adminQueryLimiter:      { check: mockAdminQueryCheck },
}));

// ── OpenAI constructor mock ───────────────────────────────────────────────────
class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  }));

(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError = MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError = MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError = MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError = MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError = MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError = MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

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

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockPoolConnect = jest.fn().mockResolvedValue({
  query: jest.fn(),
  release: jest.fn(),
});

jest.mock("@workspace/db", () => ({
  pool: { connect: mockPoolConnect },
  db: {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) })),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ onConflictDoUpdate: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([]) })) })) })),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: jest.fn().mockResolvedValue({ rows: [] }) }),
    ),
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
  rateLimitBucketsTable: {},
  collectKeywords: jest.fn(() => []),
  findNodeBySlug: jest.fn(),
  getAllTaxonomyKeywords: jest.fn(() => []),
  TAXONOMY: [],
}));

// ── Auth middleware mocks ─────────────────────────────────────────────────────
jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middlewares/requireAdminAuth", () => ({
  requireAdminAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Miscellaneous dependency mocks ────────────────────────────────────────────
jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

jest.mock("../utils/generateKeywords", () => ({
  generateKeywords: jest.fn().mockResolvedValue([]),
  mergeWithPinned: jest.fn((_ai: string[], _pinned: string[]) => []),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../app";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal valid SearchInventoryBody payload. */
const VALID_SEARCH_BODY = { keywords: "widget" };

/** Stub the given check mock to return a denied result. */
function stubDenied(mock: jest.Mock, retryAfterMs = 5_000): void {
  mock.mockResolvedValue({ allowed: false, retryAfterMs });
}

/** Stub the given check mock to return an allowed result. */
function stubAllowed(mock: jest.Mock): void {
  mock.mockResolvedValue({ allowed: true });
}

// ── POST /api/inventory/search — 429 tests ────────────────────────────────────

describe("POST /api/inventory/search — rate limit (429)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 429 when inventorySearchLimiter denies the request", async () => {
    stubDenied(mockInventorySearchCheck, 5_000);

    const res = await supertest(app)
      .post("/api/inventory/search")
      .send(VALID_SEARCH_BODY)
      .expect(429);

    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.toLowerCase()).toContain("slow down");
  });

  it("sets Retry-After header to the ceiling of retryAfterMs / 1000", async () => {
    stubDenied(mockInventorySearchCheck, 5_000);

    const res = await supertest(app)
      .post("/api/inventory/search")
      .send(VALID_SEARCH_BODY)
      .expect(429);

    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // ceil(5000 / 1000) = 5
    expect(retryAfter).toBe(5);
  });

  it("does NOT call the database when the rate limit is exceeded", async () => {
    stubDenied(mockInventorySearchCheck);

    await supertest(app)
      .post("/api/inventory/search")
      .send(VALID_SEARCH_BODY)
      .expect(429);

    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it("allows the request through when the limiter grants access", async () => {
    stubAllowed(mockInventorySearchCheck);

    // DB select returns empty results — route will succeed with empty array.
    const { db } = jest.requireMock("@workspace/db") as {
      db: { select: jest.Mock };
    };
    db.select.mockReturnValue({
      from: jest.fn(() => ({
        where: jest.fn().mockResolvedValue([]),
      })),
    });

    const res = await supertest(app)
      .post("/api/inventory/search")
      .send(VALID_SEARCH_BODY);

    expect(res.status).not.toBe(429);
  });
});

// ── POST /api/admin/query — 429 tests ─────────────────────────────────────────

describe("POST /api/admin/query — rate limit (429)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 429 when adminQueryLimiter denies the request", async () => {
    stubDenied(mockAdminQueryCheck, 12_500);

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", "Bearer any-admin-token")
      .send({ sql: "SELECT 1" })
      .expect(429);

    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.toLowerCase()).toContain("slow down");
  });

  it("sets Retry-After header to the ceiling of retryAfterMs / 1000", async () => {
    stubDenied(mockAdminQueryCheck, 12_500);

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", "Bearer any-admin-token")
      .send({ sql: "SELECT 1" })
      .expect(429);

    const retryAfter = Number(res.headers["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // ceil(12500 / 1000) = 13
    expect(retryAfter).toBe(13);
  });

  it("does NOT call the database pool when the rate limit is exceeded", async () => {
    stubDenied(mockAdminQueryCheck);

    await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", "Bearer any-admin-token")
      .send({ sql: "SELECT 1" })
      .expect(429);

    expect(mockPoolConnect).not.toHaveBeenCalled();
  });

  it("allows the request through when the limiter grants access", async () => {
    stubAllowed(mockAdminQueryCheck);

    const mockQuery = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ fields: [{ name: "id" }], rows: [{ id: 1 }] })
      .mockResolvedValueOnce({});
    const mockRelease = jest.fn();
    mockPoolConnect.mockResolvedValueOnce({ query: mockQuery, release: mockRelease });

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", "Bearer any-admin-token")
      .send({ sql: "SELECT id FROM inventory LIMIT 1" });

    expect(res.status).not.toBe(429);
  });
});
