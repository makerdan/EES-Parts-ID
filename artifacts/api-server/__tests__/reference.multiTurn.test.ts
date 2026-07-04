/**
 * Multi-turn conversation tests for POST /api/reference/ask (JSON mode).
 *
 * Verifies three requirements of the history-aware path introduced in
 * reference.ts / webSearch.ts:
 *
 *  1. When `history` is present, the request is forwarded to
 *     `callGeminiWithHistory` — prior turns appear in `contents` and the
 *     current question is appended last.
 *
 *  2. The answer cache is bypassed (getCachedAnswer is never called) when
 *     `history` is a non-empty array.
 *
 *  3. The answer cache IS consulted on a first question (no history), and a
 *     cache hit short-circuits the AI call entirely.
 *
 * All external I/O (Gemini SDK, DB, answer cache) is mocked so these tests
 * run without any network access or real database.
 */

// ── Mocks — must be declared before any imports so Jest can hoist them ───────

const mockGenerateContent = jest.fn();
const mockGetCachedAnswer = jest.fn<Promise<string | null>, [string]>();
const mockSetCachedAnswer = jest.fn<Promise<void>, [string, string, string, (boolean | undefined)?]>();

jest.mock("@workspace/integrations-gemini-ai", () => ({
  ai: {
    models: { generateContent: mockGenerateContent },
  },
  generateImage: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

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

jest.mock("@workspace/integrations-poe-server", () => ({
  poe: {},
  isPoeAuthError: jest.fn(() => false),
  isPoeTransientError: jest.fn(() => false),
  poeErrorMessage: jest.fn((err: unknown) => String(err)),
}));

jest.mock("../src/lib/answerCache", () => ({
  normalizeQuestion: (q: string): string => q.toLowerCase().trim().replace(/\s+/g, " "),
  hashQuestion: (normalized: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("crypto").createHash("sha256").update(normalized).digest("hex");
  },
  getCachedAnswer: mockGetCachedAnswer,
  setCachedAnswer: mockSetCachedAnswer,
  invalidateReferenceAnswerCache: jest.fn(),
}));

jest.mock("@workspace/db", () => {
  const resolvedEmpty = Promise.resolve([]);
  const resolvedVoid = Promise.resolve();

  const selectChain = {
    from: () => ({
      where: () => ({ limit: () => resolvedEmpty }),
      orderBy: () => ({ limit: () => resolvedEmpty }),
    }),
  };

  const insertChain = {
    values: () => ({
      onConflictDoUpdate: () => resolvedVoid,
    }),
  };

  const deleteChain = {
    where: () => resolvedVoid,
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => insertChain,
      delete: () => deleteChain,
      execute: () => resolvedVoid,
    },
    pool: { end: jest.fn() },
    inventoryTable: { description: "description", aiKeywords: "aiKeywords" },
    referenceLogTable: { createdAt: "createdAt" },
    aiRequestLogTable: { createdAt: "createdAt" },
    quickLookupCacheTable: { label: "label" },
    referenceAnswerCacheTable: { questionHash: "questionHash" },
    usersTable: { clerkUserId: "clerkUserId", status: "status", role: "role", updatedAt: "updatedAt" },
  };
});

process.env.LOG_LEVEL = "silent";

// ── Imports (after mocks) ────────────────────────────────────────────────────

import supertest from "supertest";
import app from "../src/app";

// ── Constants ─────────────────────────────────────────────────────────────────

const AI_ANSWER = "Fourteen gauge wire handles 15 amps on a standard circuit.";

const HISTORY = [
  {
    q: "What gauge wire should I use for a 20 amp circuit?",
    a: "Use 12 AWG wire for a 20 amp circuit.",
  },
];

const FOLLOW_UP_QUESTION = "And for 15 amps?";
const FIRST_QUESTION = "What gauge wire for a 15 amp circuit?";
const CACHED_ANSWER = "Use 14 AWG wire for 15 amps.";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
});

afterAll(() => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedAnswer.mockResolvedValue(null);
  mockSetCachedAnswer.mockResolvedValue(undefined);
});

// ── Test suites ───────────────────────────────────────────────────────────────

describe("POST /api/reference/ask — multi-turn conversation (JSON mode)", () => {
  describe("when history is a non-empty array", () => {
    it("forwards history turns to the Gemini call (callGeminiWithHistory)", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const callArg = mockGenerateContent.mock.calls[0]![0] as {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      };
      const { contents } = callArg;

      expect(contents[0]).toEqual({
        role: "user",
        parts: [{ text: HISTORY[0]!.q }],
      });
      expect(contents[1]).toEqual({
        role: "model",
        parts: [{ text: HISTORY[0]!.a }],
      });
      expect(contents[contents.length - 1]).toEqual({
        role: "user",
        parts: [{ text: FOLLOW_UP_QUESTION }],
      });
    });

    it("returns the AI answer in { answer } shape", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      const res = await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(res.body).toEqual({ answer: AI_ANSWER });
    });

    it("does NOT call getCachedAnswer (cache is bypassed)", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockGetCachedAnswer).not.toHaveBeenCalled();
    });

    it("does NOT write to the cache after a history-aware response", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockSetCachedAnswer).not.toHaveBeenCalled();
    });

    it("handles multiple prior turns correctly", async () => {
      const multiHistory = [
        { q: "What is AWG?", a: "AWG stands for American Wire Gauge." },
        { q: "What gauge for 20 amps?", a: "12 AWG." },
      ];

      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FOLLOW_UP_QUESTION, history: multiHistory })
        .expect(200);

      const callArg = mockGenerateContent.mock.calls[0]![0] as {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      };
      const { contents } = callArg;

      expect(contents).toHaveLength(5);
      expect(contents[0]).toEqual({ role: "user", parts: [{ text: multiHistory[0]!.q }] });
      expect(contents[1]).toEqual({ role: "model", parts: [{ text: multiHistory[0]!.a }] });
      expect(contents[2]).toEqual({ role: "user", parts: [{ text: multiHistory[1]!.q }] });
      expect(contents[3]).toEqual({ role: "model", parts: [{ text: multiHistory[1]!.a }] });
      expect(contents[4]).toEqual({ role: "user", parts: [{ text: FOLLOW_UP_QUESTION }] });
    });
  });

  describe("when no history is provided (first question / cache path)", () => {
    it("consults getCachedAnswer for a first question", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(null);
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(mockGetCachedAnswer).toHaveBeenCalledTimes(1);
    });

    it("returns the cached answer and skips the AI call on a cache hit", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(CACHED_ANSWER);

      const res = await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(res.body).toEqual({ answer: CACHED_ANSWER });
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it("calls the AI and writes to cache on a cache miss", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(null);
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      const res = await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(res.body).toEqual({ answer: AI_ANSWER });
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockSetCachedAnswer).toHaveBeenCalledTimes(1);
    });
  });

  describe("when history is an empty array (treated as no history)", () => {
    it("still consults the cache when history is []", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(CACHED_ANSWER);

      const res = await supertest(app)
        .post("/api/reference/ask?stream=false")
        .send({ question: FIRST_QUESTION, history: [] })
        .expect(200);

      expect(res.body).toEqual({ answer: CACHED_ANSWER });
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(mockGetCachedAnswer).toHaveBeenCalledTimes(1);
    });
  });
});

// ── SSE path helper ───────────────────────────────────────────────────────────

/**
 * Reconstruct the full answer text from an SSE response body by concatenating
 * every `data: {"content":"…"}` frame in order.
 */
function reconstructSseContent(body: string): string {
  const matches = [...body.matchAll(/data: (\{"content":.*?\})\n\n/g)];
  return matches
    .map((m) => (JSON.parse(m[1]!) as { content: string }).content)
    .join("");
}

// ── SSE path: multi-turn conversation ────────────────────────────────────────

describe("POST /api/reference/ask — multi-turn conversation (SSE mode)", () => {
  describe("when history is a non-empty array", () => {
    it("forwards history turns to callGeminiWithHistory (SSE)", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);

      const callArg = mockGenerateContent.mock.calls[0]![0] as {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      };
      const { contents } = callArg;

      expect(contents[0]).toEqual({
        role: "user",
        parts: [{ text: HISTORY[0]!.q }],
      });
      expect(contents[1]).toEqual({
        role: "model",
        parts: [{ text: HISTORY[0]!.a }],
      });
      expect(contents[contents.length - 1]).toEqual({
        role: "user",
        parts: [{ text: FOLLOW_UP_QUESTION }],
      });
    });

    it("streams the AI answer word-by-word and emits a done frame", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      const res = await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
      expect(reconstructSseContent(res.text)).toBe(AI_ANSWER);
      expect(res.text).toContain(`data: ${JSON.stringify({ done: true })}`);
    });

    it("does NOT call getCachedAnswer when history is present (SSE)", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockGetCachedAnswer).not.toHaveBeenCalled();
    });

    it("does NOT write to cache after a history-aware SSE response", async () => {
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FOLLOW_UP_QUESTION, history: HISTORY })
        .expect(200);

      expect(mockSetCachedAnswer).not.toHaveBeenCalled();
    });
  });

  describe("when no history is provided (SSE cache path)", () => {
    it("consults getCachedAnswer for a first question via SSE", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(null);
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(mockGetCachedAnswer).toHaveBeenCalledTimes(1);
    });

    it("returns the cached answer via SSE on a cache hit (no AI call)", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(CACHED_ANSWER);

      const res = await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(reconstructSseContent(res.text)).toBe(CACHED_ANSWER);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it("calls the AI and writes to cache on an SSE cache miss", async () => {
      mockGetCachedAnswer.mockResolvedValueOnce(null);
      mockGenerateContent.mockResolvedValueOnce({ text: AI_ANSWER });

      const res = await supertest(app)
        .post("/api/reference/ask")
        .send({ question: FIRST_QUESTION })
        .expect(200);

      expect(reconstructSseContent(res.text)).toBe(AI_ANSWER);
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockSetCachedAnswer).toHaveBeenCalledTimes(1);
    });
  });
});
