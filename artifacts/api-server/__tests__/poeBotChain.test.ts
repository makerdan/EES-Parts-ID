/**
 * Tests for the Poe bot fallback chain.
 *
 * Covers:
 *   - getPoeChainForFeature(): asserts GPT-5-Mini is absent from the
 *     `identify`, `dimensions`, and `catalog` chains and is present only in
 *     the `enrich` chain (vision-incapable bot must not appear in image paths).
 *   - tryPoeBotChain("identify"): simulates both Claude-Sonnet-4.5 and the
 *     catalog Gemini bot failing with transient errors and verifies that
 *     PoeBotChainExhaustedError is thrown after exactly 2 attempts — not 3
 *     (no silent fallback to a text-only model).
 */

// ── Env vars — must be set before any require() calls ────────────────────────
process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";
process.env.POE_CHAIN_RETRY_DELAY_MS = "0";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://test.openai.example/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-openai-key";

// ── OpenAI constructor mock ───────────────────────────────────────────────────
// poeBot.ts uses both the OpenAI constructor (for getClient()) and the static
// error sub-classes (OpenAI.RateLimitError etc.) in isPoeCallTransientError().
// We must provide both: a callable constructor AND stub classes as properties.
class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation((cfg: { apiKey: string; baseURL?: string }) => ({
    _cfg: cfg,
    chat: { completions: { create: jest.fn() } },
  }));

// Attach static error classes so `instanceof` checks in isPoeCallTransientError
// and isPoeCallAuthError do not throw "Right-hand side is not an object".
(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError = MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError = MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError = MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError = MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError = MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError = MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

// ── Workspace / infrastructure mocks ─────────────────────────────────────────
const mockDbLimit = jest.fn();
const mockDbWhere = jest.fn(() => ({ limit: mockDbLimit }));
const mockDbFrom = jest.fn(() => ({ where: mockDbWhere }));
const mockDbSelect = jest.fn(() => ({ from: mockDbFrom }));

jest.mock("@workspace/db", () => ({
  db: { select: mockDbSelect },
  adminPreferencesTable: { aiProvider: "ai_provider_col", id: "id_col" },
}));

jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

jest.mock("../src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Module imports (loaded after mocks are in place) ─────────────────────────
import type * as AiProviderModule from "../src/lib/aiProvider";
import type * as PoeBotModule from "../src/lib/poeBot";

let aiProvider: typeof AiProviderModule;
let poeBot: typeof PoeBotModule;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  aiProvider = require("../src/lib/aiProvider");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  poeBot = require("../src/lib/poeBot");
});

beforeEach(() => {
  aiProvider.setProvider("poe");
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// getPoeChainForFeature() — GPT-5-Mini chain membership
// ─────────────────────────────────────────────────────────────────────────────

describe("getPoeChainForFeature() — GPT-5-Mini chain membership", () => {
  it("identify chain does NOT include GPT-5-Mini (POE_ENRICH_BOT)", () => {
    const chain = aiProvider.getPoeChainForFeature("identify");
    expect(chain).not.toContain(aiProvider.POE_ENRICH_BOT);
  });

  it("dimensions chain does NOT include GPT-5-Mini (POE_ENRICH_BOT)", () => {
    const chain = aiProvider.getPoeChainForFeature("dimensions");
    expect(chain).not.toContain(aiProvider.POE_ENRICH_BOT);
  });

  it("catalog chain does NOT include GPT-5-Mini (POE_ENRICH_BOT)", () => {
    const chain = aiProvider.getPoeChainForFeature("catalog");
    expect(chain).not.toContain(aiProvider.POE_ENRICH_BOT);
  });

  it("enrich chain DOES include GPT-5-Mini (POE_ENRICH_BOT) as the primary bot", () => {
    const chain = aiProvider.getPoeChainForFeature("enrich");
    expect(chain).toContain(aiProvider.POE_ENRICH_BOT);
    expect(chain[0]).toBe(aiProvider.POE_ENRICH_BOT);
  });

  it("identify chain has exactly 2 bots (Claude primary + Gemini fallback)", () => {
    const chain = aiProvider.getPoeChainForFeature("identify");
    expect(chain).toHaveLength(2);
  });

  it("dimensions chain has exactly 2 bots (Claude primary + Gemini fallback)", () => {
    const chain = aiProvider.getPoeChainForFeature("dimensions");
    expect(chain).toHaveLength(2);
  });

  it("catalog chain has exactly 2 bots (Gemini primary + Claude fallback)", () => {
    const chain = aiProvider.getPoeChainForFeature("catalog");
    expect(chain).toHaveLength(2);
  });

  it("identify chain leads with Claude-Sonnet (POE_IDENTIFY_BOT) as the primary bot", () => {
    const chain = aiProvider.getPoeChainForFeature("identify");
    expect(chain[0]).toBe(aiProvider.POE_IDENTIFY_BOT);
  });

  it("dimensions chain leads with Claude-Sonnet (POE_DIMENSIONS_BOT) as the primary bot", () => {
    const chain = aiProvider.getPoeChainForFeature("dimensions");
    expect(chain[0]).toBe(aiProvider.POE_DIMENSIONS_BOT);
  });

  it("catalog chain leads with the Gemini catalog bot (POE_CATALOG_BOT) as the primary bot", () => {
    const chain = aiProvider.getPoeChainForFeature("catalog");
    expect(chain[0]).toBe(aiProvider.POE_CATALOG_BOT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryPoeBotChain("identify") — chain exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("tryPoeBotChain('identify') — exhaustion after both bots fail", () => {
  function makeTransientError(): PoeBotModule.PoeHttpError {
    return new poeBot.PoeHttpError(500, "Internal Server Error");
  }

  it("throws PoeBotChainExhaustedError when both Claude and Gemini fail with transient errors", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeBotChainExhaustedError,
    );
  });

  it("calls fn exactly 2 times — once per bot in the identify chain (not 3)", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeBotChainExhaustedError,
    );

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes bot names in chain order: Claude first, then Gemini catalog bot", async () => {
    const calledWith: string[] = [];
    const fn = jest
      .fn()
      .mockImplementation((_client: unknown, modelName: string) => {
        calledWith.push(modelName);
        return Promise.reject(makeTransientError());
      });

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeBotChainExhaustedError,
    );

    const expectedChain = aiProvider.getPoeChainForFeature("identify");
    expect(calledWith).toEqual(expectedChain);
  });

  it("does NOT call fn a 3rd time after 2 bots are exhausted", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeBotChainExhaustedError,
    );

    expect(fn).not.toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("returns the successful result if only the first bot fails and the second succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce("ok from fallback");

    const result = await poeBot.tryPoeBotChain("identify", fn);

    expect(result).toBe("ok from fallback");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-throws immediately (without trying the second bot) when the first bot throws a non-transient error", async () => {
    const permanentError = new Error("Auth failure — non-transient");
    const fn = jest.fn().mockRejectedValueOnce(permanentError);

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toThrow(
      permanentError,
    );

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryPoeBotChain("dimensions") — same 2-attempt guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("tryPoeBotChain('dimensions') — exhaustion after both bots fail", () => {
  function makeTransientError(): PoeBotModule.PoeHttpError {
    return new poeBot.PoeHttpError(500, "Internal Server Error");
  }

  it("throws PoeBotChainExhaustedError after exactly 2 attempts for dimensions chain", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(
      poeBot.tryPoeBotChain("dimensions", fn),
    ).rejects.toBeInstanceOf(poeBot.PoeBotChainExhaustedError);

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryPoeBotChain — non-poe provider bypass
// ─────────────────────────────────────────────────────────────────────────────

describe("tryPoeBotChain — non-poe provider skips chain logic", () => {
  it("calls fn exactly once when provider is 'openai'", async () => {
    aiProvider.setProvider("openai");

    const fn = jest.fn().mockResolvedValue("openai-result");
    const result = await poeBot.tryPoeBotChain("identify", fn);

    expect(result).toBe("openai-result");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
