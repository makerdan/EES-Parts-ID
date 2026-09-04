/**
 * Deterministic regression guard for Poe routing.
 *
 * This deliberately uses provider doubles rather than a live Poe call. It
 * protects the safety boundary between the live catalogue, admin overrides,
 * and request-time fallback dispatch.
 */

const mockListPoeModels = jest.fn();
const mockCreate = jest.fn();

jest.mock("@workspace/integrations-poe-server", () => ({
  getPoeClient: () => ({ chat: { completions: { create: mockCreate } } }),
  listPoeModels: mockListPoeModels,
  resetPoeClient: jest.fn(),
  withPoeRequestTimeout: (operation: (signal: AbortSignal) => Promise<unknown>) =>
    operation(new AbortController().signal),
  isPoeAuthError: (error: unknown) =>
    error !== null &&
    typeof error === "object" &&
    ((error as { status?: unknown }).status === 401 ||
      (error as { status?: unknown }).status === 403),
  isPoeTransientError: (error: unknown) =>
    error !== null &&
    typeof error === "object" &&
    (typeof (error as { status?: unknown }).status === "number" &&
      ((error as { status: number }).status >= 500)),
}));

jest.mock("@workspace/db", () => ({
  db: {},
  adminPreferencesTable: { id: "id", aiProvider: "ai_provider", aiFallbackModels: "ai_fallback_models" },
}));

jest.mock("../src/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  getPoeFeatureRoutes,
  getPoeFallbackOverrides,
  refreshPoeCatalogue,
  setPoeFallbacks,
  validatePoeFallbacks,
  POE_IDENTIFY_BOT,
} from "../src/lib/aiProvider";
import { callPoeBotWithChain } from "../src/lib/poeBot";

function model(name: string, vision = true) {
  return {
    id: name,
    name,
    modalities: ["text", "vision", "structured_output"],
    capabilities: { text: true, vision, structuredOutput: true },
  };
}

beforeEach(() => {
  mockListPoeModels.mockReset();
  mockCreate.mockReset();
  mockListPoeModels.mockResolvedValue([
    model("Claude-Sonnet-4.5"),
    model("Gemini-3.1-Pro"),
    model("Vision-Fallback"),
    model("Text-Only", false),
  ]);
});

describe("Poe routing safety boundary", () => {
  it("coalesces concurrent refreshes and filters removed or incompatible fallbacks", async () => {
    let resolveCatalogue: ((value: ReturnType<typeof model>[]) => void) | undefined;
    mockListPoeModels.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCatalogue = resolve;
      }),
    );
    const first = refreshPoeCatalogue();
    const second = refreshPoeCatalogue();
    expect(first).toBe(second);
    resolveCatalogue?.([model("Claude-Sonnet-4.5"), model("Vision-Fallback")]);
    await first;
    expect(mockListPoeModels).toHaveBeenCalledTimes(1);

    expect(setPoeFallbacks("identify", ["Vision-Fallback"])).toEqual({
      ok: true,
      models: ["Vision-Fallback"],
    });
    expect(getPoeFeatureRoutes().find((route) => route.feature === "identify")?.fallbacks).toEqual([
      "Vision-Fallback",
    ]);

    mockListPoeModels.mockResolvedValueOnce([model("Claude-Sonnet-4.5")]);
    const stale = await refreshPoeCatalogue();
    expect(stale.freshness).toBe("fresh");
    expect(getPoeFeatureRoutes().find((route) => route.feature === "identify")?.fallbacks).toEqual([]);
  });

  it("rejects unsafe updates without changing the previous override", async () => {
    await refreshPoeCatalogue();
    expect(setPoeFallbacks("identify", ["Vision-Fallback"]).ok).toBe(true);
    const before = getPoeFallbackOverrides();
    expect(validatePoeFallbacks("identify", [POE_IDENTIFY_BOT])).toEqual({
      ok: false,
      error: "The code-configured primary model cannot be a fallback",
    });
    expect(setPoeFallbacks("identify", ["Text-Only"])).toEqual({
      ok: false,
      error: expect.stringContaining("lacks the capabilities"),
    });
    expect(getPoeFallbackOverrides()).toEqual(before);
  });

  it("stops dispatch immediately on Poe authentication failures", async () => {
    await refreshPoeCatalogue();
    mockCreate.mockRejectedValue({ status: 401, message: "unauthorized" });
    await expect(callPoeBotWithChain("identify", "system", "user")).rejects.toMatchObject({ status: 401 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});