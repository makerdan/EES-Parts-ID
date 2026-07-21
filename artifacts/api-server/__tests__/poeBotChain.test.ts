/**
 * Tests for the Poe bot fallback chain.
 *
 * Covers:
 *   - getPoeChainForFeature(): verifies chain composition for all four features.
 *   - tryPoeBotChain("identify"): simulates both Claude-Sonnet-4.5 and the
 *     catalog Gemini bot failing with transient errors and verifies that
 *     PoeBotChainExhaustedError is thrown after exactly 2 attempts.
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
// getPoeChainForFeature() — chain composition
// ─────────────────────────────────────────────────────────────────────────────

describe("getPoeChainForFeature() — chain composition", () => {
  it("enrich chain DOES include POE_ENRICH_BOT (Gemini-3.1-Pro) as the primary bot", () => {
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
  // NOTE: this test file sets AI_INTEGRATIONS_OPENAI_* env vars, so the
  // Replit AI backstop IS configured: after the 2-bot Poe chain is exhausted,
  // fn is invoked one final time with the Replit AI client and the OpenAI
  // model for the feature. When that call also fails, the transient error
  // from the fallback attempt is what propagates to the caller.
  function makeTransientError(): PoeBotModule.PoeHttpError {
    return new poeBot.PoeHttpError(500, "Internal Server Error");
  }

  it("rejects with the transient error when both Poe bots AND the Replit AI backstop fail", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeHttpError,
    );
  });

  it("calls fn exactly 3 times — once per Poe bot plus the Replit AI backstop", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeHttpError,
    );

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes model names in order: the Poe chain first, then the Replit AI model", async () => {
    const calledWith: string[] = [];
    const fn = jest
      .fn()
      .mockImplementation((_client: unknown, modelName: string) => {
        calledWith.push(modelName);
        return Promise.reject(makeTransientError());
      });

    await expect(poeBot.tryPoeBotChain("identify", fn)).rejects.toBeInstanceOf(
      poeBot.PoeHttpError,
    );

    const expectedChain = aiProvider.getPoeChainForFeature("identify");
    expect(calledWith.slice(0, expectedChain.length)).toEqual(expectedChain);
    expect(calledWith).toHaveLength(expectedChain.length + 1);
  });

  it("uses the Replit AI backstop's result when the Poe chain is exhausted", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(makeTransientError())
      .mockRejectedValueOnce(makeTransientError())
      .mockResolvedValueOnce("ok from replit ai");

    await expect(poeBot.tryPoeBotChain("identify", fn)).resolves.toBe(
      "ok from replit ai",
    );
    expect(fn).toHaveBeenCalledTimes(3);
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

  it("abandons the chain (skipping the second bot) on a non-transient error and goes straight to the Replit AI backstop", async () => {
    const permanentError = new Error("Hard failure — non-transient");
    const fn = jest
      .fn()
      .mockRejectedValueOnce(permanentError)
      .mockResolvedValueOnce("ok from replit ai");

    await expect(poeBot.tryPoeBotChain("identify", fn)).resolves.toBe(
      "ok from replit ai",
    );

    // 1 Poe attempt (chain abandoned, 2nd bot skipped) + 1 Replit AI attempt.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tryPoeBotChain("dimensions") — same 2-attempt guarantee
// ─────────────────────────────────────────────────────────────────────────────

describe("tryPoeBotChain('dimensions') — exhaustion after both bots fail", () => {
  function makeTransientError(): PoeBotModule.PoeHttpError {
    return new poeBot.PoeHttpError(500, "Internal Server Error");
  }

  it("rejects after 2 Poe attempts plus the Replit AI backstop for the dimensions chain", async () => {
    const fn = jest.fn().mockRejectedValue(makeTransientError());

    await expect(
      poeBot.tryPoeBotChain("dimensions", fn),
    ).rejects.toBeInstanceOf(poeBot.PoeHttpError);

    expect(fn).toHaveBeenCalledTimes(3);
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

