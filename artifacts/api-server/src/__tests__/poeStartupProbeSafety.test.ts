const mockCreatePoeChatCompletion = jest.fn();
const mockRegistry = [
  {
    id: "Claude-Sonnet-4.5",
    name: "Claude-Sonnet-4.5",
    modalities: ["text", "vision", "structured_output"],
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
  },
  {
    id: "Gemini-3.1-Pro",
    name: "Gemini-3.1-Pro",
    modalities: ["text", "vision", "structured_output"],
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
  },
  {
    id: "Gemini-2.5-Pro",
    name: "Gemini-2.5-Pro",
    modalities: ["text", "vision", "structured_output"],
    capabilities: { text: true, vision: true, structuredOutput: true },
    capabilityConfidence: "verified",
  },
];

jest.mock("@workspace/integrations-poe-server", () => ({
  createPoeChatCompletion: mockCreatePoeChatCompletion,
  createPoeChatCompletionWithSettlement: jest.fn((request, options) => {
    const response = Promise.resolve().then(() =>
      mockCreatePoeChatCompletion(request, { ...options, maxAttempts: 1 }),
    );
    return {
      response,
      transportSettled: response.then(() => undefined, () => undefined),
    };
  }),
  getPoeClient: jest.fn(() => ({ chat: { completions: { create: jest.fn() } } })),
  getPoeModelRegistry: () => mockRegistry,
  getPoeRegistryModel: (id: string) => mockRegistry.find((model) => model.id === id),
  POE_MODEL_REGISTRY_VERSION: "static-v1",
  resetPoeClient: jest.fn(),
}));

jest.mock("@workspace/db", () => ({
  adminPreferencesTable: { id: "id" },
  db: {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn().mockResolvedValue([]) })) })),
  },
}));

jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));
jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getAllPoeModelNames,
  getLastProbeOperation,
  getProbeVerificationSummary,
  POE_PROBE_CONCURRENCY,
  POE_PROBE_AGGREGATE_TIMEOUT_MS,
  POE_PROBE_MAX_MODELS,
  POE_PROBE_TIMEOUT_MS,
  probeActivePoeModels,
  probeSinglePoeBot,
  refreshPoeCatalogue,
  setPoeFallbacks,
  setProvider,
} from "../lib/aiProvider";

describe("Poe startup and explicit probe safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setProvider("poe");
    mockCreatePoeChatCompletion.mockResolvedValue({ choices: [] });
  });

  it("retires catalogue refresh without sending a provider request", async () => {
    await expect(refreshPoeCatalogue()).resolves.toEqual(expect.objectContaining({ ok: false }));
    expect(mockCreatePoeChatCompletion).not.toHaveBeenCalled();
    expect(getAllPoeModelNames()).toEqual(
      expect.arrayContaining(["Claude-Sonnet-4.5", "Gemini-3.1-Pro"]),
    );
    expect(getAllPoeModelNames()).not.toContain("Gemini-2.5-Pro");
  });

  it("single verification is one attempt with a fixed timeout", async () => {
    const [model] = getAllPoeModelNames();
    await probeSinglePoeBot(model!);
    expect(mockCreatePoeChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockCreatePoeChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
      expect.objectContaining({ maxAttempts: 1, timeoutMs: POE_PROBE_TIMEOUT_MS }),
    );
    expect(getProbeVerificationSummary()[model!]?.verifiedAt).toEqual(expect.any(String));
  });

  it("bulk verification is limited to active routes, count, and concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    mockCreatePoeChatCompletion.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { choices: [] };
    });

    await probeActivePoeModels();

    const activeModels = getAllPoeModelNames();
    expect(mockCreatePoeChatCompletion).toHaveBeenCalledTimes(
      Math.min(activeModels.length, POE_PROBE_MAX_MODELS),
    );
    expect(maxActive).toBeLessThanOrEqual(POE_PROBE_CONCURRENCY);
    expect(getLastProbeOperation()).toEqual(expect.objectContaining({
      requested: activeModels.length,
      attempted: Math.min(activeModels.length, POE_PROBE_MAX_MODELS),
    }));
    for (const call of mockCreatePoeChatCompletion.mock.calls) {
      expect(activeModels).toContain(call[0].model);
      expect(call[1]).toEqual(expect.objectContaining({
        maxAttempts: 1,
        timeoutMs: POE_PROBE_TIMEOUT_MS,
      }));
    }
  });

  it("shares one bounded operation across overlapping bulk and single requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    mockCreatePoeChatCompletion.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { choices: [] };
    });

    const [model] = getAllPoeModelNames();
    const single = probeSinglePoeBot(model!);
    const first = probeActivePoeModels();
    const second = probeActivePoeModels();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCreatePoeChatCompletion).toHaveBeenCalledTimes(POE_PROBE_CONCURRENCY);
    expect(maxActive).toBeLessThanOrEqual(POE_PROBE_CONCURRENCY);
    release();
    await Promise.all([first, second, single]);
    expect(mockCreatePoeChatCompletion).toHaveBeenCalledTimes(
      Math.min(getAllPoeModelNames().length, POE_PROBE_MAX_MODELS) + 1,
    );
    expect(maxActive).toBeLessThanOrEqual(POE_PROBE_CONCURRENCY);
  });

  it("stops the aggregate operation at its fixed deadline with partial results", async () => {
    expect(setPoeFallbacks("enrich", ["Claude-Sonnet-4.5", "Gemini-2.5-Pro"]).ok).toBe(true);
    jest.useFakeTimers();
    mockCreatePoeChatCompletion.mockImplementation(() => new Promise(() => {}));
    try {
      const operationPromise = probeActivePoeModels();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(POE_PROBE_AGGREGATE_TIMEOUT_MS);
      const operation = await operationPromise;

      expect(operation?.budgetLimited).toBe(true);
      expect(operation?.attempted).toBeLessThan(POE_PROBE_MAX_MODELS);
      expect(Object.values(getProbeVerificationSummary())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "budget_limited", verifiedAt: null }),
        ]),
      );
      mockCreatePoeChatCompletion.mockResolvedValue({ choices: [] });
      const [model] = getAllPoeModelNames();
      const followUp = probeSinglePoeBot(model!);
      await jest.advanceTimersByTimeAsync(POE_PROBE_AGGREGATE_TIMEOUT_MS);
      await followUp;
      expect(mockCreatePoeChatCompletion).toHaveBeenCalledTimes(POE_PROBE_CONCURRENCY);
      expect(getProbeVerificationSummary()[model!]).toEqual({
        status: "budget_limited",
        verifiedAt: null,
      });
    } finally {
      setPoeFallbacks("enrich", []);
      jest.useRealTimers();
    }
  });
});