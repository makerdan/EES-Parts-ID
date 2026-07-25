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
    // Assert on the constructor arguments recorded by the mock rather than
    // reading the internal _cfg field — if the client implementation changes
    // its internal storage the cast would silently succeed and return undefined.
    // beforeEach clears mockCreatedConfigs after calling setProvider, so we
    // trigger a fresh setProvider("poe") here to record a new constructor call.
    mod.setProvider("poe");
    // Runtime-safe: setProvider() above always pushes a config entry.
    const cfg = mockCreatedConfigs[mockCreatedConfigs.length - 1]!;
    expect(cfg.baseURL).toBe("https://api.poe.com/v1");
    expect(cfg.apiKey).toBe("test-poe-key");
  });

  it("switches to the openai client after setProvider('openai')", () => {
    mod.setProvider("openai");

    // Runtime-safe: setProvider() above always pushes a config entry.
    const cfg = mockCreatedConfigs[mockCreatedConfigs.length - 1]!;
    expect(cfg.baseURL).toBe("https://test.openai.example/v1");
    expect(cfg.apiKey).toBe("test-openai-key");
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

    // Runtime-safe: the second setProvider("poe") above always pushes a config entry.
    const cfg = mockCreatedConfigs[mockCreatedConfigs.length - 1]!;
    expect(cfg.baseURL).toBe("https://api.poe.com/v1");
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

// ─────────────────────────────────────────────────────────────────────────────
// probePoeBotsOnStartup()
// ─────────────────────────────────────────────────────────────────────────────

describe("probePoeBotsOnStartup()", () => {
  type MockClient = { chat: { completions: { create: jest.Mock } } };

  // Helper: get logger mocks from the hoisted jest.mock() factory
  function getLoggerMocks() {
    return jest.requireMock<{ logger: { info: jest.Mock; warn: jest.Mock } }>(
      "../src/lib/logger",
    ).logger;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    // Ensure we are on the poe provider (outer beforeEach already does this,
    // but make it explicit so the intent is clear in this describe block)
    mod.setProvider("poe");
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves and logs a timeout warning for each bot when create never resolves", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    // Hang indefinitely — never resolves, never rejects
    client.chat.completions.create.mockImplementation(() => new Promise(() => {}));

    const probePromise = mod.probePoeBotsOnStartup();

    // Advance past the 15 000 ms probe timeout so all per-bot timers fire
    await jest.advanceTimersByTimeAsync(15100);
    await probePromise;

    const botNames = mod.getAllPoeModelNames();
    const { warn } = getLoggerMocks();

    expect(warn).toHaveBeenCalledTimes(botNames.length);
    for (const botName of botNames) {
      expect(warn).toHaveBeenCalledWith(
        { botName },
        expect.stringContaining("probe timed out"),
      );
    }
  });

  it("logs '— OK' for each bot when create resolves promptly", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    const botNames = mod.getAllPoeModelNames();
    const { info, warn } = getLoggerMocks();

    // No warnings — all bots responded successfully
    expect(warn).not.toHaveBeenCalled();

    for (const botName of botNames) {
      expect(info).toHaveBeenCalledWith(
        { botName },
        expect.stringContaining("— OK"),
      );
    }
  });

  it("is a no-op when the active provider is not 'poe'", async () => {
    mod.setProvider("openai");
    jest.clearAllMocks();

    await mod.probePoeBotsOnStartup();

    const { info, warn } = getLoggerMocks();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("does not leave any dangling timers after a successful probe", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    // All per-bot timeouts should have been naturally cancelled (Promise.race
    // won the race), so running all pending timers produces no extra warn calls
    await jest.runAllTimersAsync();
    const { warn } = getLoggerMocks();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a 'not found' warning for each bot when create rejects with status 404", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockRejectedValue({ status: 404 });

    await mod.probePoeBotsOnStartup();

    const botNames = mod.getAllPoeModelNames();
    const { warn } = getLoggerMocks();

    // When all bots return 404, the catalog bot also probes its fallback (which
    // also returns 404), generating one extra warn — so total = botNames.length + 1.
    expect(warn).toHaveBeenCalledTimes(botNames.length + 1);

    // Each primary bot (including catalog) gets a "not found" / "not found — probing
    // fallback" message that contains the words "not found".
    for (const botName of botNames) {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ botName }),
        expect.stringContaining("not found"),
      );
    }
    // The fallback bot also gets a warn about being unavailable.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ botName: mod.POE_CATALOG_BOT_FALLBACK }),
      expect.stringContaining("unavailable"),
    );
  });

  it("logs a 'probe failed' warning for each bot when create rejects with a generic error", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    const genericError = new Error("Service Unavailable");
    client.chat.completions.create.mockRejectedValue(genericError);

    await mod.probePoeBotsOnStartup();

    const botNames = mod.getAllPoeModelNames();
    const { warn } = getLoggerMocks();

    expect(warn).toHaveBeenCalledTimes(botNames.length);
    for (const botName of botNames) {
      expect(warn).toHaveBeenCalledWith(
        { botName, err: genericError },
        expect.stringContaining("probe failed"),
      );
    }
  });

  it("one bot throwing an unrecognized error shape does not silence the remaining bots", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    const botNames = mod.getAllPoeModelNames();

    // First bot throws a raw non-Error value (unrecognised shape)
    client.chat.completions.create
      .mockImplementationOnce(() => { throw "totally unexpected string"; })
      // All subsequent bots succeed
      .mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    const { info, warn } = getLoggerMocks();

    // Exactly one warning — for the single failing bot
    expect(warn).toHaveBeenCalledTimes(1);

    // All remaining bots (everything after the first) are logged as OK
    const okBots = botNames.slice(1);
    for (const botName of okBots) {
      expect(info).toHaveBeenCalledWith(
        { botName },
        expect.stringContaining("— OK"),
      );
    }
  });

  it("resolves without throwing even when every bot throws an unrecognized error shape", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    const botNames = mod.getAllPoeModelNames();

    // Every bot throws a non-Error value
    client.chat.completions.create.mockImplementation(() => {
      throw { weird: true, code: "UNKNOWN_SHAPE" };
    });

    await expect(mod.probePoeBotsOnStartup()).resolves.toBeUndefined();

    const { warn } = getLoggerMocks();
    // One warning per bot — no bot is silenced
    expect(warn).toHaveBeenCalledTimes(botNames.length);
  });

  it("logs a warn with the bot name for each bot that throws an unrecognized error shape", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    const botNames = mod.getAllPoeModelNames();
    const unexpectedErr = { code: "UNEXPECTED" };

    client.chat.completions.create.mockImplementation(() => {
      throw unexpectedErr;
    });

    await mod.probePoeBotsOnStartup();

    const { warn } = getLoggerMocks();
    for (const botName of botNames) {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ botName }),
        expect.any(String),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POE_ENRICH_BOT coverage in probePoeBotsOnStartup()
//
// Explicit regression guard: these tests pin the fact that POE_ENRICH_BOT
// (Gemini-3.1-Pro) is included in the startup probe. Generic tests above cover
// all bots via getAllPoeModelNames(); these tests fail *specifically* if the
// enrich bot is dropped from that list or its probe branch silently changes.
// ─────────────────────────────────────────────────────────────────────────────

describe("probePoeBotsOnStartup() — POE_ENRICH_BOT (Gemini-3.1-Pro) coverage", () => {
  type MockClient = { chat: { completions: { create: jest.Mock } } };

  function getLoggerMocks() {
    return jest.requireMock<{ logger: { info: jest.Mock; warn: jest.Mock } }>(
      "../src/lib/logger",
    ).logger;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mod.setProvider("poe");
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("getAllPoeModelNames() includes POE_ENRICH_BOT so the startup probe covers enrichment", () => {
    expect(mod.getAllPoeModelNames()).toContain(mod.POE_ENRICH_BOT);
  });

  it("getAllPoeModelNames() returns a deduplicated list (no repeated bot names)", () => {
    const names = mod.getAllPoeModelNames();
    expect(names.length).toBe(new Set(names).size);
  });

  it("logs '— OK' for POE_ENRICH_BOT when its probe resolves", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    const { info } = getLoggerMocks();
    expect(info).toHaveBeenCalledWith(
      { botName: mod.POE_ENRICH_BOT },
      expect.stringContaining("— OK"),
    );
  });

  it("logs a structured warning for POE_ENRICH_BOT when it returns 404 — does not throw", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === mod.POE_ENRICH_BOT) throw { status: 404 };
        return { choices: [] };
      },
    );

    await expect(mod.probePoeBotsOnStartup()).resolves.toBeUndefined();

    const { warn } = getLoggerMocks();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ botName: mod.POE_ENRICH_BOT }),
      expect.stringContaining("not found"),
    );
  });

  it("logs a structured warning for POE_ENRICH_BOT on a transient error — does not throw", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    const transientError = new Error("Service Unavailable");
    client.chat.completions.create.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === mod.POE_ENRICH_BOT) throw transientError;
        return { choices: [] };
      },
    );

    await expect(mod.probePoeBotsOnStartup()).resolves.toBeUndefined();

    const { warn } = getLoggerMocks();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ botName: mod.POE_ENRICH_BOT }),
      expect.stringContaining("probe failed"),
    );
  });

  it("records POE_ENRICH_BOT as 'ok' in getProbeSummary() after a successful probe", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    expect(mod.getProbeSummary()[mod.POE_ENRICH_BOT]).toBe("ok");
  });

  it("records POE_ENRICH_BOT as '404' in getProbeSummary() when it is not found", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === mod.POE_ENRICH_BOT) throw { status: 404 };
        return { choices: [] };
      },
    );

    await mod.probePoeBotsOnStartup();

    expect(mod.getProbeSummary()[mod.POE_ENRICH_BOT]).toBe("404");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProbeSummary()
// ─────────────────────────────────────────────────────────────────────────────

describe("getProbeSummary()", () => {
  type MockClient = { chat: { completions: { create: jest.Mock } } };

  beforeEach(() => {
    jest.useFakeTimers();
    mod.setProvider("poe");
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns an empty object when the provider is not 'poe', regardless of past probe runs", () => {
    // getProbeSummary() guards on the active provider, so switching to openai
    // always returns {} even if a poe probe already ran (stale module state).
    mod.setProvider("openai");
    expect(mod.getProbeSummary()).toEqual({});
  });

  it("returns 'ok' for every bot when all probes resolve promptly", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockResolvedValue({ choices: [] });

    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    const botNames = mod.getAllPoeModelNames();
    for (const name of botNames) {
      expect(summary[name]).toBe("ok");
    }
  });

  it("returns 'timeout' for every bot when create never resolves", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockImplementation(() => new Promise(() => {}));

    const probePromise = mod.probePoeBotsOnStartup();
    await jest.advanceTimersByTimeAsync(15100);
    await probePromise;

    const summary = mod.getProbeSummary();
    const botNames = mod.getAllPoeModelNames();
    for (const name of botNames) {
      expect(summary[name]).toBe("timeout");
    }
  });

  it("returns '404' for every bot when create rejects with status 404", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockRejectedValue({ status: 404 });

    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    const botNames = mod.getAllPoeModelNames();
    for (const name of botNames) {
      // Catalog bot falls back and both primary and fallback appear in the summary.
      // Non-catalog 404 bots get "404".
      if (name === mod.POE_CATALOG_BOT) {
        expect(summary[name]).toBe("404");
      } else {
        expect(summary[name]).toBe("404");
      }
    }
  });

  it("returns 'error' for every bot when create rejects with a generic error", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    client.chat.completions.create.mockRejectedValue(new Error("Service Unavailable"));

    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    const botNames = mod.getAllPoeModelNames();
    for (const name of botNames) {
      expect(summary[name]).toBe("error");
    }
  });

  it("records the fallback catalog bot as 'ok' when primary is 404 and fallback succeeds", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    // Mock by model name so the result is independent of call order (probes run in parallel).
    client.chat.completions.create.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === mod.POE_CATALOG_BOT) throw { status: 404 };
        return { choices: [] };
      },
    );

    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    expect(summary[mod.POE_CATALOG_BOT]).toBe("404");
    expect(summary[mod.POE_CATALOG_BOT_FALLBACK]).toBe("ok");
  });

  it("records the fallback catalog bot as 'error' when both primary and fallback fail", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    // Mock by model name: primary catalog → 404, fallback → generic error, all others → ok.
    client.chat.completions.create.mockImplementation(
      async ({ model }: { model: string }) => {
        if (model === mod.POE_CATALOG_BOT) throw { status: 404 };
        if (model === mod.POE_CATALOG_BOT_FALLBACK) throw new Error("fallback down");
        return { choices: [] };
      },
    );

    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    expect(summary[mod.POE_CATALOG_BOT]).toBe("404");
    expect(summary[mod.POE_CATALOG_BOT_FALLBACK]).toBe("error");
  });

  it("clears previous results when probePoeBotsOnStartup() is called again", async () => {
    const client = mod.getAiClient() as unknown as MockClient;
    // First probe: all fail
    client.chat.completions.create.mockRejectedValue(new Error("down"));
    await mod.probePoeBotsOnStartup();

    // Second probe: all succeed
    jest.clearAllMocks();
    client.chat.completions.create.mockResolvedValue({ choices: [] });
    await mod.probePoeBotsOnStartup();

    const summary = mod.getProbeSummary();
    const botNames = mod.getAllPoeModelNames();
    for (const name of botNames) {
      expect(summary[name]).toBe("ok");
    }
  });

  it("returns an empty object when the active provider is not 'poe'", async () => {
    mod.setProvider("openai");

    await mod.probePoeBotsOnStartup();

    expect(mod.getProbeSummary()).toEqual({});
  });

  it("returns a plain object (not the internal Map)", () => {
    const summary = mod.getProbeSummary();
    expect(summary).not.toBeInstanceOf(Map);
    expect(typeof summary).toBe("object");
  });
});
