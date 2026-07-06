/**
 * Tests for X-Request-Id tracing middleware.
 *
 * Verifies that:
 *  1. Every response includes an X-Request-Id header with a UUID.
 *  2. When the client supplies X-Request-Id, the same value is echoed back.
 *  3. Error responses (500) include `requestId` in the JSON body so callers
 *     can report it.
 *
 * The bootstrap-admin identity is used so that requireAppAuth is fully
 * satisfied without a real database round-trip (the insert/upsert chain is
 * stubbed). The route under test is GET /api/healthz which is a public path
 * that bypasses auth entirely, making it the cleanest probe for middleware
 * behaviour.
 *
 * For the error-response test we need a route that throws. We reuse the
 * GET /api/admin/ai-status pattern from routeHandlerErrorPath.test.ts because
 * it forwards exceptions to next(err) and the bootstrap admin skips the DB.
 */

// ── Env — must come before any imports ───────────────────────────────────────
const BOOTSTRAP_ADMIN_ID = "jest-reqid-bootstrap-admin";
process.env.ADMIN_CLERK_USER_ID = BOOTSTRAP_ADMIN_ID;

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockOnConflictDoUpdate = jest.fn().mockResolvedValue([]);
const mockInsertValues = jest.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));
const mockLimit = jest.fn().mockResolvedValue([]);
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: jest.fn(),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn(),
    delete: jest.fn(),
  },
  pool: { connect: jest.fn() },
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
  catalogPdfJobTable: {},
  warehouseZoneTable: {},
  adminPreferencesTable: {},
  collectKeywords: jest.fn(() => []),
  findNodeBySlug: jest.fn(),
  getAllTaxonomyKeywords: jest.fn(() => []),
  TAXONOMY: [],
}));

// ── AI provider mock ──────────────────────────────────────────────────────────
const mockGetProbeSummary = jest.fn(() => ({}));

jest.mock("../lib/aiProvider", () => ({
  getProbeSummary: mockGetProbeSummary,
  getAllPoeModelNames: jest.fn(() => []),
  probePoeBotsOnStartup: jest.fn().mockResolvedValue(undefined),
  probeSinglePoeBot: jest.fn().mockResolvedValue(undefined),
  getEnrichModel: jest.fn().mockReturnValue("test-model"),
  getOpenAIFallbackClient: jest.fn(),
  getOpenAIModelForFeature: jest.fn().mockReturnValue("gpt-4o"),
  getAiClient: jest.fn(),
  getProvider: jest.fn().mockReturnValue("openai"),
  setProvider: jest.fn(),
  callPoeBotWithChain: jest.fn(),
  tryPoeBotChain: jest.fn(),
  PoeBotChainExhaustedError: class PoeBotChainExhaustedError extends Error {},
  MAX_IMAGE_BYTES_CLAUDE_SONNET: 1_048_576,
  MAX_IMAGE_BYTES_GPT5_1: 1_048_576,
}));

// ── Peripheral mocks so app.ts (all route modules) can be imported ────────────
jest.mock("openai", () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

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

jest.mock("../lib/rateLimiter", () => ({
  identifyLimiter:         { check: jest.fn().mockResolvedValue({ allowed: true }) },
  translateLimiter:        { check: jest.fn().mockResolvedValue({ allowed: true }) },
  partCardLimiter:         { check: jest.fn().mockResolvedValue({ allowed: true }) },
  referenceAskLimiter:     { check: jest.fn().mockResolvedValue({ allowed: true }) },
  catalogPdfUploadLimiter: { check: jest.fn().mockResolvedValue({ allowed: true }) },
  inventorySearchLimiter:  { check: jest.fn().mockResolvedValue({ allowed: true }) },
  adminQueryLimiter:       { check: jest.fn().mockResolvedValue({ allowed: true }) },
}));

jest.mock("../lib/answerCache", () => ({
  invalidateReferenceAnswerCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(),
}));

jest.mock("../utils/generateKeywords", () => ({
  generateKeywords: jest.fn().mockResolvedValue([]),
  mergeWithPinned: jest.fn(() => []),
}));

import supertest from "supertest";

import app from "../app";
import { logger } from "../lib/logger";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  jest.clearAllMocks();
  mockOnConflictDoUpdate.mockResolvedValue([]);
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockGetProbeSummary.mockReturnValue({});
});

describe("X-Request-Id middleware", () => {
  it("generates a UUID v4 X-Request-Id header when none is supplied", async () => {
    const res = await supertest(app)
      .get("/api/healthz")
      .expect(200);

    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).toMatch(UUID_RE);
  });

  it("echoes back the caller-supplied X-Request-Id unchanged", async () => {
    const clientId = "my-client-request-id-abc123";
    const res = await supertest(app)
      .get("/api/healthz")
      .set("X-Request-Id", clientId)
      .expect(200);

    expect(res.headers["x-request-id"]).toBe(clientId);
  });

  it("includes requestId in the 500 error response body", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);
    const clientId = "tracing-error-test-id";

    mockGetProbeSummary.mockImplementation(() => {
      throw new Error("simulated failure for requestId test");
    });

    try {
      const res = await supertest(app)
        .get("/api/admin/ai-status")
        .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
        .set("X-Request-Id", clientId)
        .expect(500);

      expect(res.body).toMatchObject({
        error: "Internal server error",
        requestId: clientId,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("generates a fresh requestId when none is supplied and includes it in error body", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);

    mockGetProbeSummary.mockImplementation(() => {
      throw new Error("simulated failure for auto-id test");
    });

    try {
      const res = await supertest(app)
        .get("/api/admin/ai-status")
        .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
        .expect(500);

      const bodyId = res.body.requestId as string;
      const headerId = res.headers["x-request-id"] as string;

      expect(bodyId).toMatch(UUID_RE);
      expect(headerId).toMatch(UUID_RE);
      expect(bodyId).toBe(headerId);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rate-limit 429 response carries the X-Request-Id header", async () => {
    const clientId = "rate-limit-tracing-test-id";
    const { identifyLimiter } = jest.requireMock("../lib/rateLimiter") as {
      identifyLimiter: { check: jest.Mock };
    };
    identifyLimiter.check.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
      .set("X-Request-Id", clientId)
      .send({ images: [] })
      .expect(429);

    expect(res.headers["x-request-id"]).toBe(clientId);
  });

  it("bootstrap admin logger.warn includes requestId in log payload", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    const clientId = "bootstrap-warn-requestid-test";

    try {
      await supertest(app)
        .get("/api/admin/ai-status")
        .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
        .set("X-Request-Id", clientId)
        .expect(200);

      const bootstrapCalls = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "object" && args[0] !== null && (args[0] as Record<string, unknown>).bootstrapAdmin === true,
      );
      expect(bootstrapCalls.length).toBeGreaterThan(0);
      expect(bootstrapCalls[0]![0]).toMatchObject({ requestId: clientId });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
