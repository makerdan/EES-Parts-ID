/**
 * Deterministic regression guard for Poe routing.
 *
 * This deliberately uses provider doubles rather than a live Poe call. It
 * protects the safety boundary between the static registry, admin overrides,
 * and request-time fallback dispatch.
 */

const mockCreate = jest.fn();
const mockRegistry = [
  model("Claude-Sonnet-4.5"),
  model("Gemini-3.1-Pro"),
  model("Gemini-2.5-Pro"),
];

jest.mock("@workspace/integrations-poe-server", () => ({
  getPoeClient: () => ({ chat: { completions: { create: mockCreate } } }),
  getPoeModelRegistry: () => mockRegistry,
  getPoeRegistryModel: (id: string) => mockRegistry.find((candidate) => candidate.id === id),
  POE_MODEL_REGISTRY_VERSION: "static-v1",
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
  resetPoeFallbacks,
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
  resetPoeFallbacks();
  mockCreate.mockReset();
});

describe("Poe routing safety boundary", () => {
  it("retires catalogue refresh without contacting Poe", async () => {
    const result = await refreshPoeCatalogue();
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/retired/i),
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(getPoeFeatureRoutes().find((route) => route.feature === "identify")?.fallbacks).not.toContain(
      "Vision-Fallback",
    );
  });

  it("filters unknown or incompatible fallbacks against the static registry", () => {
    expect(setPoeFallbacks("identify", ["Gemini-3.1-Pro"])).toEqual({
      ok: true,
      models: ["Gemini-3.1-Pro"],
    });
    expect(getPoeFeatureRoutes().find((route) => route.feature === "identify")?.fallbacks).toEqual([
      "Gemini-3.1-Pro",
    ]);

    expect(setPoeFallbacks("identify", ["Vision-Fallback"])).toEqual({
      ok: false,
      error: expect.stringMatching(/not in the configured Poe registry/i),
    });
  });

  it("rejects unsafe updates without changing the previous override", () => {
    expect(setPoeFallbacks("identify", ["Gemini-3.1-Pro"]).ok).toBe(true);
    const before = getPoeFallbackOverrides();
    expect(validatePoeFallbacks("identify", [POE_IDENTIFY_BOT])).toEqual({
      ok: false,
      error: "The code-configured primary model cannot be a fallback",
    });
    expect(setPoeFallbacks("identify", ["Text-Only"])).toEqual({
      ok: false,
      error: expect.stringMatching(/not in the configured Poe registry/i),
    });
    expect(getPoeFallbackOverrides()).toEqual(before);
  });

  it("stops dispatch immediately on Poe authentication failures", async () => {
    mockCreate.mockRejectedValue({ status: 401, message: "unauthorized" });
    await expect(callPoeBotWithChain("identify", "system", "user")).rejects.toMatchObject({ status: 401 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});