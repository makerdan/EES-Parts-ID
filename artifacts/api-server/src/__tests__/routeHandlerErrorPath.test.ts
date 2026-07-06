/**
 * Tests that an unhandled error thrown inside a *route handler* (not just auth
 * middleware) reaches the global Express error handler in app.ts and returns a
 * clean JSON 500 response — not a raw HTML stack trace or an Express default
 * plain-text body.
 *
 * Specifically, this exercises the path:
 *   route handler catches error → calls next(err)
 *   → global error handler in app.ts
 *   → { error: "Internal server error" } (no internal detail leaked)
 *   → logger.error() records the error (not silently swallowed)
 *
 * The route under test is GET /api/admin/ai-status (adminAiStatus.ts), which
 * calls getProbeSummary() and forwards any exception to next(err). The bootstrap
 * admin identity bypasses the real database so the only moving part is the route
 * handler itself.
 *
 * Pattern follows requireAppAuthErrorPath.test.ts.
 */

// ── Env vars — must be set before any module imports ─────────────────────────
const BOOTSTRAP_ADMIN_ID = "jest-route-err-bootstrap-admin";
process.env.ADMIN_CLERK_USER_ID = BOOTSTRAP_ADMIN_ID;

// ── DB mock — must be declared before any module imports ─────────────────────
// The bootstrap admin path in requireAppAuth calls
//   db.insert(usersTable).values(...).onConflictDoUpdate(...)
// All other DB operations should be unreachable in this test, but the select
// chain is stubbed as a safety net.
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

// ── AI provider mock ─────────────────────────────────────────────────────────
// getProbeSummary is the function that GET /admin/ai-status calls. We keep a
// reference so individual tests can make it throw.
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

// ── Peripheral mocks so app.ts (all route modules) can be imported ───────────
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

const ROUTE_ERROR = new Error("simulated DB failure inside route handler");

beforeEach(() => {
  jest.clearAllMocks();
  // Restore insert chain (clearAllMocks wipes implementations).
  mockOnConflictDoUpdate.mockResolvedValue([]);
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockInsert.mockReturnValue({ values: mockInsertValues });
  // Default: getProbeSummary succeeds (happy path). Individual tests override.
  mockGetProbeSummary.mockReturnValue({});
});

describe("route handler error path — global error handler (app.ts)", () => {
  it("returns 500 JSON and logs the error when a route handler calls next(err)", async () => {
    // Force the route handler to encounter an error it forwards to next(err).
    mockGetProbeSummary.mockImplementation(() => {
      throw ROUTE_ERROR;
    });

    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const response = await supertest(app)
        .get("/api/admin/ai-status")
        .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
        .expect(500);

      // Body must be clean JSON — no stack trace, no Express HTML default.
      expect(response.body).toMatchObject({ error: "Internal server error" });

      // Content-Type must be JSON (not text/html that Express sends by default).
      expect(response.headers["content-type"]).toMatch(/application\/json/);

      // The structured logger must have recorded the error so it is not
      // silently swallowed.
      const handlerCall = errorSpy.mock.calls.find(
        ([payload]) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { err?: unknown }).err === ROUTE_ERROR,
      );
      expect(handlerCall).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not leak internal error detail in the response body", async () => {
    mockGetProbeSummary.mockImplementation(() => {
      throw new Error("SECRET_DB_CONNECTION_STRING_EXPOSED");
    });

    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const response = await supertest(app)
        .get("/api/admin/ai-status")
        .set("Authorization", `Bearer ${BOOTSTRAP_ADMIN_ID}`)
        .expect(500);

      const bodyText = JSON.stringify(response.body);
      expect(bodyText).not.toContain("SECRET_DB_CONNECTION_STRING_EXPOSED");
      expect(response.body).toHaveProperty("error", "Internal server error");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
