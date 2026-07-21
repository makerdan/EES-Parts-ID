/**
 * Integration tests for POST /api/ai/translate-query and POST /api/ai/part-card.
 *
 * The AI client is mocked so no live API key or network call is required.
 * The part-card DB cache table is exercised against the real database with
 * JEST-prefixed cache keys that are cleaned up afterwards.
 */

const mockCreate = jest.fn();

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

// Replace getAiClient with a factory returning the mockCreate-backed client so
// translate-query and part-card never make network calls.
jest.mock("../src/lib/aiProvider", () => {
  const actual = jest.requireActual<typeof import("../src/lib/aiProvider")>("../src/lib/aiProvider");
  return {
    ...actual,
    getAiClient: jest.fn(() => ({
      chat: { completions: { create: mockCreate } },
    })),
    getEnrichModel: jest.fn(() => "test-enrich-model"),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────
import { db, partCardCacheTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import OpenAI from "openai";
import supertest from "supertest";

import app from "../src/app";
import { partCardLimiter, translateLimiter } from "../src/lib/rateLimiter";

/** Builds a real OpenAI APIError subclass instance for a given HTTP status. */
function makeOpenAiError(status: number, message: string): Error {
  return OpenAI.APIError.generate(
    status,
    { error: { message } },
    message,
    new Headers(),
  );
}

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
});

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
  // Remove part-card cache rows written by the fire-and-forget upsert
  await db
    .delete(partCardCacheTable)
    .where(sql`${partCardCacheTable.catalogKey} LIKE 'jest-pc-%'`);
}, 15_000);

beforeEach(async () => {
  await translateLimiter.reset();
  await partCardLimiter.reset();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/translate-query
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/ai/translate-query", () => {
  it("returns 400 when query is missing", async () => {
    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({})
      .expect(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when query is whitespace only", async () => {
    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "   " })
      .expect(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it("returns 200 with translated terms for a successful mocked response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              translatedTerms: ["GFCI receptacle", "20A"],
              interpretation: "A ground-fault outlet rated 20 amps",
              appliedTranslation: true,
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "shock proof outlet" })
      .expect(200);

    expect(res.body.translatedTerms).toEqual(["GFCI receptacle", "20A"]);
    expect(res.body.interpretation).toMatch(/ground-fault/i);
    expect(res.body.appliedTranslation).toBe(true);
    // Non-zeroResults path must not include the zero-results fields
    expect(res.body).not.toHaveProperty("substitutes");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns safe defaults when the AI response is malformed", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "not json at all" } }],
    });

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "weird thing" })
      .expect(200);

    expect(res.body.translatedTerms).toEqual([]);
    expect(res.body.interpretation).toBe("");
    expect(res.body.appliedTranslation).toBe(false);
  });

  it("returns the extended zero-results shape when zeroResults=true", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              translatedTerms: ["circuit breaker"],
              interpretation: "A breaker",
              appliedTranslation: true,
              partName: "Circuit breaker",
              partSpecs: ["20A", "single pole"],
              catalogNumbers: ["BR120"],
              suggestedRequery: "JESTNONEXISTENTPART-XYZ",
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "breaker thing", zeroResults: true })
      .expect(200);

    expect(res.body.partName).toBe("Circuit breaker");
    expect(res.body.partSpecs).toEqual(["20A", "single pole"]);
    expect(res.body.catalogNumbers).toEqual(["BR120"]);
    expect(res.body.suggestedRequery).toBe("JESTNONEXISTENTPART-XYZ");
    expect(Array.isArray(res.body.substitutes)).toBe(true);
  });

  it("falls back to joined translatedTerms when suggestedRequery is absent", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              translatedTerms: ["duplex", "receptacle"],
              appliedTranslation: true,
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "wall plug", zeroResults: true })
      .expect(200);

    expect(res.body.suggestedRequery).toBe("duplex receptacle");
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    jest
      .spyOn(translateLimiter, "check")
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 5000 });

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "anything" })
      .expect(429);

    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body.error).toMatch(/too many/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 401 when the AI provider rejects with an auth error", async () => {
    mockCreate.mockRejectedValueOnce(makeOpenAiError(401, "invalid api key"));

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "anything" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 429 when the AI provider rejects with a rate-limit error", async () => {
    mockCreate.mockRejectedValueOnce(makeOpenAiError(429, "rate limited"));

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "anything" })
      .expect(429);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 503 when the AI provider rejects with a transient server error", async () => {
    mockCreate.mockRejectedValueOnce(makeOpenAiError(500, "internal error"));

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "anything" })
      .expect(503);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 500 when the AI client throws a generic error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"));

    const res = await supertest(app)
      .post("/api/ai/translate-query")
      .send({ query: "anything" })
      .expect(500);

    expect(res.body.error).toMatch(/translation failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/part-card
// ─────────────────────────────────────────────────────────────────────────────

/** Unique per-test catalog so the in-process L1 cache never bleeds between tests. */
let pcCounter = 0;
function nextCatalog(): string {
  pcCounter += 1;
  return `JEST-PC-${Date.now()}-${pcCounter}`;
}

const GOOD_PART_CARD = {
  displayName: "Test Breaker 20A",
  specs: [{ label: "Amperage", value: "20A" }],
  crossRefs: ["XREF-1"],
  compatibilityNote: "Fits test panels",
};

describe("POST /api/ai/part-card", () => {
  it("returns 400 when catalog is missing", async () => {
    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/catalog/i);
  });

  it("returns 200 with the parsed part card and cachedAt null on a cache miss", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(GOOD_PART_CARD) } }],
    });

    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog: nextCatalog(), vendor: "EATON" })
      .expect(200);

    expect(res.body.displayName).toBe("Test Breaker 20A");
    expect(res.body.specs).toEqual([{ label: "Amperage", value: "20A" }]);
    expect(res.body.crossRefs).toEqual(["XREF-1"]);
    expect(res.body.compatibilityNote).toBe("Fits test panels");
    expect(res.body.cachedAt).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("serves the second identical request from cache without a new AI call", async () => {
    const catalog = nextCatalog();
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(GOOD_PART_CARD) } }],
    });

    await supertest(app).post("/api/ai/part-card").send({ catalog }).expect(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const res2 = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog })
      .expect(200);

    // Still exactly one AI call — second response came from the L1 cache
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res2.body.displayName).toBe("Test Breaker 20A");
  });

  it("force=true bypasses the cache and makes a fresh AI call", async () => {
    const catalog = nextCatalog();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(GOOD_PART_CARD) } }],
    });

    await supertest(app).post("/api/ai/part-card").send({ catalog }).expect(200);
    await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog, force: true })
      .expect(200);

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns empty fields (and does not cache) when the AI has no information", async () => {
    const catalog = nextCatalog();
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ displayName: "", specs: [], crossRefs: [], compatibilityNote: "" }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog })
      .expect(200);

    expect(res.body.displayName).toBe("");
    expect(res.body.specs).toEqual([]);

    // Empty result is not cached — the next request calls the AI again
    await supertest(app).post("/api/ai/part-card").send({ catalog }).expect(200);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("filters malformed spec entries out of the AI response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              displayName: "Thing",
              specs: [
                { label: "Voltage", value: "120V" },
                { label: 42, value: "bad" },
                "not an object",
                null,
              ],
              crossRefs: ["A", 7, null],
              compatibilityNote: 99,
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog: nextCatalog() })
      .expect(200);

    expect(res.body.specs).toEqual([{ label: "Voltage", value: "120V" }]);
    expect(res.body.crossRefs).toEqual(["A"]);
    expect(res.body.compatibilityNote).toBe("");
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    jest
      .spyOn(partCardLimiter, "check")
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 3000 });

    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog: nextCatalog() })
      .expect(429);

    expect(res.headers["retry-after"]).toBe("3");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 401 when the AI provider rejects with an auth error", async () => {
    mockCreate.mockRejectedValueOnce(makeOpenAiError(401, "invalid api key"));

    await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog: nextCatalog() })
      .expect(401);
  });

  it("returns 500 when the AI client throws a generic error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("boom"));

    const res = await supertest(app)
      .post("/api/ai/part-card")
      .send({ catalog: nextCatalog() })
      .expect(500);

    expect(res.body.error).toMatch(/part card lookup failed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/reference — removed endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/ai/reference", () => {
  it("returns 410 Gone with a pointer to the replacement endpoint", async () => {
    const res = await supertest(app)
      .post("/api/ai/reference")
      .send({ question: "anything" })
      .expect(410);

    expect(res.body.error).toMatch(/reference\/ask/i);
  });
});
