/**
 * Integration tests for POST /api/ai/identify.
 *
 * The OpenAI client is mocked so no live API key is required.
 * The database is NOT exercised by these tests.
 */

// ── Mock OpenAI integration BEFORE app is imported ───────────────────────────

/**
 * Build a bare base64 string whose decoded byte-size estimate exceeds `byteCount`.
 * Using Math.ceil ensures the round-trip `ceil(chars * 3/4)` is always > byteCount,
 * which is what we need for the "over the limit" integration tests.
 */
function base64OverBytes(byteCount: number): string {
  return "A".repeat(Math.ceil((byteCount * 4) / 3) + 1);
}

/**
 * A single oversized image string computed once at module load time.
 * Decodes to slightly over 20 MB — sufficient to trigger the 413 guard.
 * Generated once to avoid repeated large-string allocations across tests.
 */
const OVERSIZED_IMAGE = base64OverBytes(20 * 1024 * 1024);

/**
 * A "large" image chunk (~11 MB decoded) used for the combined-size test.
 * Two of these sum to ~22 MB which exceeds the 20 MB limit while keeping
 * the total JSON body well under Express's 50 MB body limit.
 */
const LARGE_CHUNK = base64OverBytes(11 * 1024 * 1024);

/**
 * An image that decodes to just over 10 MB.
 * Exceeds Claude Sonnet's 10 MB per-image limit (Poe path) but stays well
 * under OpenAI's 20 MB per-image limit (OpenAI fallback path).
 * Used to verify the per-model guard fires on the Poe path only.
 */
const CLAUDE_OVERSIZED_IMAGE = base64OverBytes(10 * 1024 * 1024);

const mockCreate = jest.fn();

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
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

// ── Mock getOpenAIFallbackClient so fallback-path tests never hit the network ─
// When x-use-openai-fallback: true, ai.ts calls getOpenAIFallbackClient()
// directly (not via tryPoeBotChain).  We replace it with a factory that
// returns the same mockCreate-backed client used everywhere else.
jest.mock("../src/lib/aiProvider", () => {
  const actual = jest.requireActual<typeof import("../src/lib/aiProvider")>("../src/lib/aiProvider");
  return {
    ...actual,
    getOpenAIFallbackClient: jest.fn(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

// ── Mock the Poe bot chain so tests never make real network calls ─────────────
// tryPoeBotChain is replaced with a thin wrapper that invokes the caller's
// function with a dummy client whose create method is `mockCreate`.  This
// makes every test that reaches the AI call fast, deterministic, and free of
// network dependencies regardless of which AI_PROVIDER is configured.
jest.mock("../src/lib/poeBot", () => {
  class PoeBotChainExhaustedError extends Error {
    constructor() {
      super("All Poe bots in the fallback chain failed");
      this.name = "PoeBotChainExhaustedError";
    }
  }
  return {
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: mockCreate } } }, "test-model"),
    ),
    PoeBotChainExhaustedError,
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { closePool } from "./helpers/testDb";

// Minimal valid base64 string (1×1 white pixel JPEG)
const TINY_BASE64_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EAB4QAAEEAgMAAAAAAAAAAAAAAAEAAgMREiExQf/EABUBAQEAAAAAAAAAAAAAAAAAAAID/8QAFxEBAQEBAAAAAAAAAAAAAAAAAQACEf/aAAwDAQACEQMRAD8AoN1tq+bNT5e1C7RERFk//9k=";

beforeAll(() => {
  process.env.ADMIN_PASSWORD = "jest-ai-test-secret";
});

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/identify
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/ai/identify", () => {
  it("returns 400 when no images are provided", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({})
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/image/i);
  });

  it("returns 400 when images is an empty array", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [] })
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 200 with the correct shape for a successful mocked response", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              searchTerms: ["circuit breaker", "BR120"],
              synonyms: ["breaker"],
              relatedTerms: ["panel", "load center"],
              manufacturerVerified: true,
              detectedVendor: "Eaton",
              summary: "Single pole 20A residential circuit breaker.",
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(200);

    expect(res.body).toHaveProperty("searchTerms");
    expect(res.body).toHaveProperty("synonyms");
    expect(res.body).toHaveProperty("relatedTerms");
    expect(res.body).toHaveProperty("manufacturerVerified");
    expect(res.body).toHaveProperty("detectedVendor");
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("results");

    expect(Array.isArray(res.body.searchTerms)).toBe(true);
    expect(res.body.searchTerms).toContain("circuit breaker");
    expect(res.body.detectedVendor).toBe("Eaton");
    expect(res.body.manufacturerVerified).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it("returns 200 with defaults when the AI response contains malformed JSON", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "This part looks like a breaker. No JSON here." } }],
    });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(200);

    // normalizeAnalysis provides safe defaults when JSON extraction fails
    expect(Array.isArray(res.body.searchTerms)).toBe(true);
    expect(typeof res.body.manufacturerVerified).toBe("boolean");
    expect(res.body.manufacturerVerified).toBe(false);
    expect(res.body.detectedVendor).toBeNull();
  });

  it("returns 200 with empty defaults when the AI response is an empty object", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "{}" } }],
    });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(200);

    expect(res.body.searchTerms).toEqual([]);
    expect(res.body.synonyms).toEqual([]);
    expect(res.body.relatedTerms).toEqual([]);
    expect(res.body.manufacturerVerified).toBe(false);
    expect(res.body.detectedVendor).toBeNull();
    expect(res.body.summary).toBe("");
  });

  it("passes optional context fields to the AI prompt (smoke test)", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              searchTerms: ["switch"],
              synonyms: [],
              relatedTerms: [],
              manufacturerVerified: false,
              detectedVendor: null,
              summary: "A switch.",
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({
        images: [TINY_BASE64_JPEG],
        keywords: "toggle switch",
        vendor: "Hubbell",
        color: "white",
      })
      .expect(200);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Verify context fields are forwarded into the prompt messages
    const callArg = mockCreate.mock.calls[0][0];
    const userMsg = callArg.messages.find((m: { role: string }) => m.role === "user");
    const userText = JSON.stringify(userMsg?.content ?? "");
    expect(userText).toMatch(/toggle switch/i);
    expect(userText).toMatch(/Hubbell/i);

    expect(res.body.searchTerms).toContain("switch");
  });

  it("returns 500 when the OpenAI client throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(500);

    expect(res.body).toHaveProperty("error");
  });

  // ── Oversized payload guard ────────────────────────────────────────────────

  it("returns 413 when a single image exceeds the 20 MB payload limit", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    // The AI client must NOT have been called — we short-circuit before the network
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 413 when multiple images combined exceed the 20 MB limit", async () => {
    // Two ~11 MB chunks → ~22 MB combined, which exceeds the 20 MB guard.
    // Total JSON stays well under Express's 50 MB body limit.
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [LARGE_CHUNK, LARGE_CHUNK] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("413 error message mentions the size limit in MB", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body.error).toMatch(/MB/);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("413 error message includes an actionable hint", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body.error).toMatch(/smaller or fewer images/i);
  });

  // ── Provider-level payload-too-large errors ────────────────────────────────

  it("returns 413 when the AI provider rejects with a status-413 error", async () => {
    const providerError = Object.assign(new Error("Request entity too large"), { status: 413 });
    mockCreate.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/smaller or fewer images/i);
  });

  it("returns 413 when the AI provider rejects with a 'too large' message", async () => {
    mockCreate.mockRejectedValueOnce(new Error("image too large for provider request"));

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/smaller or fewer images/i);
  });

  it("returns 413 when the AI provider rejects with a request_too_large code", async () => {
    const providerError = Object.assign(new Error("Request too large"), { code: "request_too_large" });
    mockCreate.mockRejectedValueOnce(providerError);

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/smaller or fewer images/i);
  });

  it("does NOT return 413 for a generic AI error (falls through to 500)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Internal server error"));

    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(500);

    expect(res.body).toHaveProperty("error");
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/identify — per-model image size guard
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/ai/identify — per-model image size guard", () => {
  // ── Poe path (default — no x-use-openai-fallback header) ────────────────────

  it("returns 413 on the Poe path when a single image exceeds Claude's 10 MB per-image limit", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [CLAUDE_OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    // Short-circuits before any AI call
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("413 per-image message names the offending image number and mentions MB and limit", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [CLAUDE_OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body.error).toMatch(/image 1/i);
    expect(res.body.error).toMatch(/MB/);
    expect(res.body.error).toMatch(/limit/i);
  });

  it("413 per-image message includes an actionable hint about using a smaller image", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [CLAUDE_OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body.error).toMatch(/smaller image/i);
  });

  it("returns 413 on the Poe path when the second image (not the first) exceeds 10 MB", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .send({ images: [TINY_BASE64_JPEG, CLAUDE_OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body.error).toMatch(/image 2/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // ── OpenAI fallback path (x-use-openai-fallback: true) ──────────────────────

  it("accepts a 10–20 MB image on the OpenAI fallback path (per-image Claude check is skipped)", async () => {
    // CLAUDE_OVERSIZED_IMAGE decodes to just over 10 MB.  On the Poe path it
    // would be rejected with 413 by the per-image Claude check.  On the OpenAI
    // fallback path that check is skipped, so the request should reach the AI
    // and succeed.  getOpenAIFallbackClient is mocked at module level so no
    // live network call is made.
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              searchTerms: ["relay"],
              synonyms: [],
              relatedTerms: [],
              manufacturerVerified: false,
              detectedVendor: null,
              summary: "A relay.",
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post("/api/ai/identify")
      .set("x-use-openai-fallback", "true")
      .send({ images: [CLAUDE_OVERSIZED_IMAGE] })
      .expect(200);

    expect(res.body).toHaveProperty("searchTerms");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns 413 on the OpenAI fallback path when the image exceeds the 20 MB aggregate limit", async () => {
    const res = await supertest(app)
      .post("/api/ai/identify")
      .set("x-use-openai-fallback", "true")
      .send({ images: [OVERSIZED_IMAGE] })
      .expect(413);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/too large/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
