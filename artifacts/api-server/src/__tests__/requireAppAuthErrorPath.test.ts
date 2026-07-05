/**
 * Tests that unexpected errors inside requireAppAuth are surfaced, not
 * silently swallowed.
 *
 * Two layers of coverage:
 *
 * 1. Unit: requireAppAuth is called directly with a mocked db whose user-lookup
 *    query rejects. The test asserts next(err) is called with that exact error
 *    (and that no response was written), so the error reaches Express's global
 *    error handler instead of becoming an unhandled rejection.
 *
 * 2. App-level: the real app from app.ts is mounted via supertest. The same DB
 *    failure is injected and the test asserts the global error handler in
 *    app.ts converts it to a 500 JSON response AND that the structured logger
 *    recorded the error (i.e. it is not silently swallowed).
 *
 * The peripheral mocks below (AI providers, rate limiter, object storage, etc.)
 * exist only so that importing app.ts — which pulls in every route module —
 * succeeds in the Jest CJS environment. requireAppAuth itself is intentionally
 * NOT mocked so the real middleware + real global error handler are exercised.
 */

// ── DB mock — must be declared before any module imports ─────────────────────
// requireAppAuth's non-bootstrap path calls db.select().from().where().limit().
// Make .limit() reject so the error propagates out of the middleware.
const mockLimit = jest.fn();
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

jest.mock("@workspace/db", () => ({
  db: {
    select: mockSelect,
    insert: jest.fn(),
    update: jest.fn(),
    execute: jest.fn().mockResolvedValue({ rows: [] }),
    transaction: jest.fn(),
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

import { type NextFunction, type Request, type Response } from "express";
import supertest from "supertest";

import app from "../app";
import { logger } from "../lib/logger";
import { requireAppAuth } from "../middlewares/requireAppAuth";

const DB_ERROR = new Error("simulated DB failure inside requireAppAuth");

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_CLERK_USER_ID;
  mockLimit.mockRejectedValue(DB_ERROR);
});

describe("requireAppAuth — unexpected error handling (unit)", () => {
  it("calls next(err) with the thrown error and does not write a response", async () => {
    const statusMock = jest.fn().mockReturnThis();
    const jsonMock = jest.fn().mockReturnThis();

    const req = {
      path: "/inventory",
      headers: { authorization: "Bearer some-user-id" },
    } as unknown as Request;

    const res = {
      status: statusMock,
      json: jsonMock,
      locals: {},
    } as unknown as Response;

    const next = jest.fn() as unknown as NextFunction;

    await requireAppAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(DB_ERROR);
    expect(statusMock).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
  });
});

describe("requireAppAuth — unexpected error handling (app.ts global handler)", () => {
  it("returns a 500 JSON response and logs the error", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => logger);

    try {
      const response = await supertest(app)
        .get("/api/inventory")
        .set("Authorization", "Bearer some-user-id")
        .expect(500);

      expect(response.body).toEqual({ error: "Internal server error" });

      // The structured logger recorded the error — it was not silently swallowed.
      const handlerCall = errorSpy.mock.calls.find(
        ([payload]) =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { err?: unknown }).err === DB_ERROR,
      );
      expect(handlerCall).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
