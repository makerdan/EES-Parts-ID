/**
 * @jest-environment node
 *
 * Unit tests for runTranslateQuery (utils/translateQuery.ts).
 *
 * The critical regression this suite guards against:
 *   A bare `catch {}` that swallows network/HTTP errors would leave
 *   aiZeroResults in the `loading: true` state forever when zeroResults=true.
 *   After the fix, the catch block MUST call setAIZeroResults with
 *   `error: "AI unavailable"`.
 *
 * Covered scenarios
 * ─────────────────
 * Fetch failure (network error)
 *   1. setAIZeroResults is called with error:"AI unavailable" when zeroResults=true
 *   2. setAIZeroResults is NOT called when zeroResults=false (error is still logged)
 *   3. Stale generation (gen mismatch) suppresses the error state update
 *
 * Non-OK HTTP response (treated as an error via thrown exception)
 *   4. setAIZeroResults is called with error:"AI unavailable" for a 500 response
 *   5. setAIZeroResults is called with error:"AI unavailable" for a 503 response
 *
 * Null / empty response body
 *   6. Null data body → error:"AI unavailable" when zeroResults=true
 *
 * Success paths
 *   7. Zero-results enrichment: setAIZeroResults called with error:null and data
 *   8. Translation path: setAITranslation called when appliedTranslation=true
 *   9. Stale generation on success suppresses state updates
 */

import { runTranslateQuery } from "../utils/translateQuery";
import type { TranslateQueryDeps, AIZeroResultsState } from "../utils/translateQuery";

// ── fetch mock helpers ─────────────────────────────────────────────────────────

function makeOkResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

// ── Dependency factory ─────────────────────────────────────────────────────────

type Mocks = {
  getGen: jest.Mock<number>;
  setAIZeroResults: jest.Mock<void, [AIZeroResultsState]>;
  setAITranslation: jest.Mock;
  setAITranslationDismissed: jest.Mock;
};

function makeDeps(currentGen = 0): { deps: TranslateQueryDeps; mocks: Mocks } {
  const mocks: Mocks = {
    getGen: jest.fn(() => currentGen),
    setAIZeroResults: jest.fn(),
    setAITranslation: jest.fn(),
    setAITranslationDismissed: jest.fn(),
  };
  const deps: TranslateQueryDeps = {
    apiBase: "http://localhost:8080/api",
    getGen: mocks.getGen,
    setAIZeroResults: mocks.setAIZeroResults,
    setAITranslation: mocks.setAITranslation,
    setAITranslationDismissed: mocks.setAITranslationDismissed,
  };
  return { deps, mocks };
}

// ── Fetch failure (network error) ─────────────────────────────────────────────

describe("runTranslateQuery — fetch failure (network error)", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sets aiZeroResults.error to 'AI unavailable' when zeroResults=true", async () => {
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("breaker 20A", true, 0, deps);

    expect(mocks.setAIZeroResults).toHaveBeenCalledTimes(1);
    const call = mocks.setAIZeroResults.mock.calls[0]![0];
    expect(call.error).toBe("AI unavailable");
    expect(call.loading).toBe(false);
  });

  it("does NOT call setAIZeroResults when zeroResults=false", async () => {
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("20A breaker", false, 0, deps);

    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });

  it("suppresses state update when generation counter has advanced (stale response)", async () => {
    const { deps, mocks } = makeDeps(1); // currentGen=1, but we call with gen=0

    await runTranslateQuery("relay", true, 0, deps);

    // gen(0) !== currentGen(1) → update must be suppressed
    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });
});

// ── Non-OK HTTP response ───────────────────────────────────────────────────────

describe("runTranslateQuery — non-OK HTTP response", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sets error:'AI unavailable' for a 500 response when zeroResults=true", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(500));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("conduit 1 inch", true, 0, deps);

    expect(mocks.setAIZeroResults).toHaveBeenCalledTimes(1);
    expect(mocks.setAIZeroResults.mock.calls[0]![0].error).toBe("AI unavailable");
  });

  it("sets error:'AI unavailable' for a 503 response when zeroResults=true", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(503));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("wire gauge 12", true, 0, deps);

    expect(mocks.setAIZeroResults).toHaveBeenCalledTimes(1);
    expect(mocks.setAIZeroResults.mock.calls[0]![0].error).toBe("AI unavailable");
  });

  it("does NOT call setAIZeroResults for a non-OK response when zeroResults=false", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(500));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("wire", false, 0, deps);

    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });
});

// ── Null/empty response body ───────────────────────────────────────────────────

describe("runTranslateQuery — null response body", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sets error:'AI unavailable' when the API returns null body and zeroResults=true", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(null as unknown as object));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("switch 240V", true, 0, deps);

    expect(mocks.setAIZeroResults).toHaveBeenCalledTimes(1);
    expect(mocks.setAIZeroResults.mock.calls[0]![0].error).toBe("AI unavailable");
  });
});

// ── Success paths ─────────────────────────────────────────────────────────────

describe("runTranslateQuery — success: zero-results enrichment", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls setAIZeroResults with error:null and data fields when zeroResults=true", async () => {
    const responseBody = {
      partName: "20A Breaker",
      partSpecs: ["20A", "240V"],
      catalogNumbers: ["BR2020"],
      substitutes: [],
    };
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(responseBody));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("20 amp breaker", true, 0, deps);

    expect(mocks.setAIZeroResults).toHaveBeenCalledTimes(1);
    const call = mocks.setAIZeroResults.mock.calls[0]![0];
    expect(call.error).toBeNull();
    expect(call.partName).toBe("20A Breaker");
    expect(call.partSpecs).toEqual(["20A", "240V"]);
    expect(call.catalogNumbers).toEqual(["BR2020"]);
    expect(call.loading).toBe(false);
  });

  it("does not call setAIZeroResults when zeroResults=true and generation has advanced", async () => {
    const responseBody = { partName: "Relay", partSpecs: [], catalogNumbers: [], substitutes: [] };
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(responseBody));
    // gen=0 passed to the call, but getGen() now returns 1 (user started a new search)
    const { deps, mocks } = makeDeps(1);

    await runTranslateQuery("relay", true, 0, deps);

    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });
});

describe("runTranslateQuery — success: translation enrichment (non-zero results)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls setAITranslation when appliedTranslation=true and translatedTerms are present", async () => {
    const responseBody = {
      appliedTranslation: true,
      translatedTerms: ["circuit breaker", "20A"],
      interpretation: "A 20-amp breaker",
    };
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(responseBody));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("breaker 20 amp", false, 0, deps);

    expect(mocks.setAITranslation).toHaveBeenCalledWith({
      terms: ["circuit breaker", "20A"],
      interpretation: "A 20-amp breaker",
    });
    expect(mocks.setAITranslationDismissed).toHaveBeenCalledWith(false);
    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });

  it("does not call setAITranslation when appliedTranslation=false", async () => {
    const responseBody = { appliedTranslation: false, translatedTerms: ["relay"], interpretation: "A relay" };
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(responseBody));
    const { deps, mocks } = makeDeps(0);

    await runTranslateQuery("relay", false, 0, deps);

    expect(mocks.setAITranslation).not.toHaveBeenCalled();
    expect(mocks.setAIZeroResults).not.toHaveBeenCalled();
  });
});
