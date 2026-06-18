/**
 * Unit tests for aiProvider.ts
 *
 * Covers:
 *   - setProvider() swaps the active OpenAI client and getAiClient() returns the
 *     new instance immediately after the switch
 *   - getProvider() always reflects the currently active provider name
 *   - Model helpers (getEnrichModel, getIdentifyModel, getCatalogModel, etc.) return
 *     the correct value for each provider
 *   - initProvider() reads the persisted provider from the DB and applies it via
 *     setProvider() when a valid value is found
 *   - initProvider() is a no-op when the DB row is absent
 *   - initProvider() logs a warning and does not throw when the DB call fails
 */

// ── env vars ──────────────────────────────────────────────────────────────────
// These must be in the module body (not in beforeAll) so they are set before the
// first require() below — jest.mock() factories are lazy, but process.env reads
// in the module body of aiProvider.ts happen at require() time.
//
// We set them here rather than relying on .env files so the tests are hermetic.
process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://test.openai.example/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-openai-key";

// ── Track every OpenAI constructor call ───────────────────────────────────────
// Variable names must start with "mock" so Jest's babel transform allows them to
// be referenced inside the hoisted jest.mock() factory below.
const mockCreatedConfigs: Array<{ apiKey: string; baseURL?: string }> = [];

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation((cfg: { apiKey: string; baseURL?: string }) => {
    const inst = {
      _cfg: cfg,
      chat: { completions: { create: jest.fn() } },
    };
    mockCreatedConfigs.push(cfg);
    return inst;
  });

jest.mock("openai", () => mockOpenAIConstructor);

// ── Drizzle fluent-chain mock for initProvider() ──────────────────────────────
const mockDbLimit = jest.fn();
const mockDbWhere = jest.fn(() => ({ limit: mockDbLimit }));
const mockDbFrom = jest.fn(() => ({ where: mockDbWhere }));
const mockDbSelect = jest.fn(() => ({ from: mockDbFrom }));

jest.mock("@workspace/db", () => ({
  db: { select: mockDbSelect },
  adminPreferencesTable: { aiProvider: "ai_provider_col", id: "id_col" },
}));

jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

// ── Logger mock ───────────────────────────────────────────────────────────────
const mockLoggerWarn = jest.fn();
jest.mock("../src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn() },
}));

// ── Import the module under test ──────────────────────────────────────────────
// We use a type-only import for IntelliSense and a runtime require() in beforeAll
// so the module is loaded *after* the env vars above have been evaluated.
import type * as AiProviderModule from "../src/lib/aiProvider";

let mod: typeof AiProviderModule;

const originalEnv = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  POE_API_KEY2: process.env.POE_API_KEY2,
  AI_INTEGRATIONS_OPENAI_BASE_URL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  AI_INTEGRATIONS_OPENAI_API_KEY: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
};

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mod = require("../src/lib/aiProvider");
});

afterAll(() => {
  // Restore env vars to avoid cross-suite contamination
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

beforeEach(() => {
  // Reset to a known baseline between tests
  mod.setProvider("poe");
  jest.clearAllMocks();
  mockCreatedConfigs.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// setProvider() + getAiClient()
// ─────────────────────────────────────────────────────────────────────────────

describe("setProvider() and getAiClient()", () => {
  it("getAiClient() returns an instance configured for poe by default", () => {
    const client = mod.getAiClient() as unknown as { _cfg: { apiKey: string; baseURL: string } };
    expect(client._cfg.baseURL).toBe("https://api.poe.com/v1");
    expect(client._cfg.apiKey).toBe("test-poe-key");
  });

  it("switches to the openai client after setProvider('openai')", () => {
    mod.setProvider("openai");

    const client = mod.getAiClient() as unknown as { _cfg: { apiKey: string; baseURL: string } };
    expect(client._cfg.baseURL).toBe("https://test.openai.example/v1");
    expect(client._cfg.apiKey).toBe("test-openai-key");
  });

  it("the client reference returned by getAiClient() changes after setProvider()", () => {
    const before = mod.getAiClient();
    mod.setProvider("openai");
    const after = mod.getAiClient();

    expect(after).not.toBe(before);
  });

  it("creates a new OpenAI instance on each setProvider() call", () => {
    mod.setProvider("openai");
    mod.setProvider("poe");

    // Two new instances should have been constructed (one for each setProvider call)
    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(2);
  });

  it("switching back to poe re-configures the client with the Poe base URL", () => {
    mod.setProvider("openai");
    mod.setProvider("poe");

    const client = mod.getAiClient() as unknown as { _cfg: { apiKey: string; baseURL: string } };
    expect(client._cfg.baseURL).toBe("https://api.poe.com/v1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProvider()
// ─────────────────────────────────────────────────────────────────────────────

describe("getProvider()", () => {
  it("returns 'poe' initially (matches AI_PROVIDER env var)", () => {
    expect(mod.getProvider()).toBe("poe");
  });

  it("returns 'openai' after setProvider('openai')", () => {
    mod.setProvider("openai");
    expect(mod.getProvider()).toBe("openai");
  });

  it("returns 'poe' again after switching back", () => {
    mod.setProvider("openai");
    mod.setProvider("poe");
    expect(mod.getProvider()).toBe("poe");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("model helpers reflect the active provider", () => {
  it("getEnrichModel() returns the Poe enrich bot name when provider is 'poe'", () => {
    expect(mod.getEnrichModel()).toBe(mod.POE_ENRICH_BOT);
  });

  it("getEnrichModel() returns 'gpt-4o-mini' when provider is 'openai'", () => {
    mod.setProvider("openai");
    expect(mod.getEnrichModel()).toBe("gpt-4o-mini");
  });

  it("getIdentifyModel() returns the Poe identify bot name when provider is 'poe'", () => {
    expect(mod.getIdentifyModel()).toBe(mod.POE_IDENTIFY_BOT);
  });

  it("getIdentifyModel() returns 'gpt-4o' when provider is 'openai'", () => {
    mod.setProvider("openai");
    expect(mod.getIdentifyModel()).toBe("gpt-4o");
  });

  it("getCatalogModel() returns the dedicated catalog bot (Gemini) when provider is 'poe'", () => {
    expect(mod.getCatalogModel()).toBe(mod.POE_CATALOG_BOT);
    expect(mod.getCatalogModel()).not.toBe(mod.POE_IDENTIFY_BOT);
  });

  it("getCatalogModel() returns 'gpt-4o' when provider is 'openai'", () => {
    mod.setProvider("openai");
    expect(mod.getCatalogModel()).toBe("gpt-4o");
  });

  it("getReferenceModel() matches getEnrichModel() for both providers", () => {
    expect(mod.getReferenceModel()).toBe(mod.getEnrichModel());
    mod.setProvider("openai");
    expect(mod.getReferenceModel()).toBe(mod.getEnrichModel());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// initProvider()
// ─────────────────────────────────────────────────────────────────────────────

describe("initProvider()", () => {
  it("applies the DB-persisted provider when it is 'openai'", async () => {
    mockDbLimit.mockResolvedValueOnce([{ aiProvider: "openai" }]);

    await mod.initProvider();

    expect(mod.getProvider()).toBe("openai");
  });

  it("applies the DB-persisted provider when it is 'poe'", async () => {
    // Start with openai to prove the switch goes back to poe
    mod.setProvider("openai");
    mockDbLimit.mockResolvedValueOnce([{ aiProvider: "poe" }]);

    await mod.initProvider();

    expect(mod.getProvider()).toBe("poe");
  });

  it("queries the adminPreferences row with id=1", async () => {
    mockDbLimit.mockResolvedValueOnce([]);
    const { eq } = jest.requireMock<{ eq: jest.Mock }>("drizzle-orm");
    const { adminPreferencesTable } =
      jest.requireMock<{ adminPreferencesTable: { id: unknown; aiProvider: unknown } }>("@workspace/db");

    await mod.initProvider();

    expect(mockDbSelect).toHaveBeenCalledTimes(1);
    expect(mockDbFrom).toHaveBeenCalledTimes(1);
    expect(mockDbWhere).toHaveBeenCalledTimes(1);
    expect(mockDbLimit).toHaveBeenCalledWith(1);
    // Verify the exact filter: eq(adminPreferencesTable.id, 1)
    expect(eq).toHaveBeenCalledWith(adminPreferencesTable.id, 1);
  });

  it("does not change provider when the DB row is absent (empty array)", async () => {
    mockDbLimit.mockResolvedValueOnce([]);

    await mod.initProvider();

    // Provider should remain at the env-var default (poe)
    expect(mod.getProvider()).toBe("poe");
  });

  it("does not change provider when the DB value is null", async () => {
    mockDbLimit.mockResolvedValueOnce([{ aiProvider: null }]);

    await mod.initProvider();

    expect(mod.getProvider()).toBe("poe");
  });

  it("does not throw when the DB call rejects", async () => {
    mockDbLimit.mockRejectedValueOnce(new Error("connection refused"));

    await expect(mod.initProvider()).resolves.toBeUndefined();
  });

  it("logs a warning when the DB call rejects", async () => {
    mockDbLimit.mockRejectedValueOnce(new Error("connection refused"));

    await mod.initProvider();

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it("leaves the provider unchanged when the DB call rejects", async () => {
    mockDbLimit.mockRejectedValueOnce(new Error("connection refused"));

    await mod.initProvider();

    expect(mod.getProvider()).toBe("poe");
  });
});
