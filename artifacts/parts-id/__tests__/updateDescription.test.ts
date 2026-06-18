/**
 * @jest-environment node
 *
 * Unit tests for performUpdateDescription (utils/updateDescription.ts).
 *
 * Covers:
 *   (a) success — addedCatalogs is updated and the modal closes.
 *   (b) API error — updateDescriptionError is shown, modal stays open.
 *   (c) Network failure — updateDescriptionError is shown, modal stays open.
 *   (d) 401 response — logoutAdmin is called, no other state is mutated.
 */

import { performUpdateDescription, UpdateDescriptionDeps } from "../utils/updateDescription";

// ── fetch mock helpers ─────────────────────────────────────────────────────────

function makeOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: object = {}): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeJsonParseFailResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => { throw new Error("bad json"); },
  } as unknown as Response;
}

// ── Dependency factory ─────────────────────────────────────────────────────────

type Mocks = {
  logoutAdmin: jest.Mock;
  setUpdatingDescription: jest.Mock;
  setUpdateDescriptionError: jest.Mock;
  setAddedCatalogs: jest.Mock;
  setAddModalPart: jest.Mock;
  setDuplicateItem: jest.Mock;
};

function makeDeps(overrides: Partial<UpdateDescriptionDeps> = {}): { deps: UpdateDescriptionDeps; mocks: Mocks } {
  const mocks: Mocks = {
    logoutAdmin: jest.fn(),
    setUpdatingDescription: jest.fn(),
    setUpdateDescriptionError: jest.fn(),
    setAddedCatalogs: jest.fn(),
    setAddModalPart: jest.fn(),
    setDuplicateItem: jest.fn(),
  };

  const deps: UpdateDescriptionDeps = {
    apiBase: "https://example.com/api",
    authHeaders: { Authorization: "Bearer tok-abc" },
    duplicateItemId: 7,
    description: "New description text",
    catalogNumber: "ACME-123",
    logoutAdmin: mocks.logoutAdmin,
    setUpdatingDescription: mocks.setUpdatingDescription,
    setUpdateDescriptionError: mocks.setUpdateDescriptionError,
    setAddedCatalogs: mocks.setAddedCatalogs,
    setAddModalPart: mocks.setAddModalPart,
    setDuplicateItem: mocks.setDuplicateItem,
    ...overrides,
  };

  return { deps, mocks };
}

// ── (a) Success path ───────────────────────────────────────────────────────────

describe("performUpdateDescription — success", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls fetch with the correct PATCH URL and body", async () => {
    const { deps } = makeDeps();
    await performUpdateDescription(deps);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://example.com/api/admin/inventory/7/description",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ description: "New description text" }),
      }),
    );
  });

  it("includes the Authorization header", async () => {
    const { deps } = makeDeps();
    await performUpdateDescription(deps);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-abc");
  });

  it("adds the catalog number to addedCatalogs", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddedCatalogs).toHaveBeenCalledTimes(1);
    // The updater function receives the previous Set and must include the catalog number.
    const updater = mocks.setAddedCatalogs.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    const result = updater(new Set(["EXISTING-001"]));
    expect(result.has("ACME-123")).toBe(true);
    expect(result.has("EXISTING-001")).toBe(true);
  });

  it("calls setAddModalPart to close the modal", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);
    expect(mocks.setAddModalPart).toHaveBeenCalledTimes(1);
  });

  it("calls setDuplicateItem to clear the duplicate state", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);
    expect(mocks.setDuplicateItem).toHaveBeenCalledTimes(1);
  });

  it("sets updatingDescription true then false (via finally)", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const calls = mocks.setUpdatingDescription.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[0]).toBe(true);
    expect(calls[calls.length - 1]).toBe(false);
  });

  it("clears any previous error at the start", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);
    expect(mocks.setUpdateDescriptionError).toHaveBeenCalledWith(null);
  });

  it("does not set an error message on success", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const errorCalls = mocks.setUpdateDescriptionError.mock.calls
      .filter(([v]: [string | null]) => v !== null);
    expect(errorCalls).toHaveLength(0);
  });

  it("does not call logoutAdmin on a 200 response", async () => {
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);
    expect(mocks.logoutAdmin).not.toHaveBeenCalled();
  });

  it("skips setAddedCatalogs when catalogNumber is null", async () => {
    const { deps, mocks } = makeDeps({ catalogNumber: null });
    await performUpdateDescription(deps);
    expect(mocks.setAddedCatalogs).not.toHaveBeenCalled();
    expect(mocks.setAddModalPart).toHaveBeenCalledTimes(1);
    expect(mocks.setDuplicateItem).toHaveBeenCalledTimes(1);
  });
});

// ── (b) API error path ─────────────────────────────────────────────────────────

describe("performUpdateDescription — API error (non-ok response)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows the server error message when the API returns one", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(422, { error: "Description cannot be empty." }),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setUpdateDescriptionError).toHaveBeenCalledWith("Description cannot be empty.");
  });

  it("falls back to generic message when the API error body has no 'error' key", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(500, {}),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setUpdateDescriptionError).toHaveBeenCalledWith("Failed to update description.");
  });

  it("falls back to generic message when JSON parsing the error body fails", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeJsonParseFailResponse(500),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setUpdateDescriptionError).toHaveBeenCalledWith("Failed to update description.");
  });

  it("does NOT close the modal (setAddModalPart not called) on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(422, { error: "Bad input." }),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
    expect(mocks.setDuplicateItem).not.toHaveBeenCalled();
  });

  it("does NOT update addedCatalogs on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(422, { error: "Bad input." }),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddedCatalogs).not.toHaveBeenCalled();
  });

  it("still sets updatingDescription false in finally on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(503, {}),
    );
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const calls = mocks.setUpdatingDescription.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// ── (c) Network failure path ───────────────────────────────────────────────────

describe("performUpdateDescription — network failure (fetch throws)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a 'Network error' message when fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setUpdateDescriptionError).toHaveBeenCalledWith("Network error. Please try again.");
  });

  it("does NOT close the modal on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
    expect(mocks.setDuplicateItem).not.toHaveBeenCalled();
  });

  it("does NOT update addedCatalogs on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddedCatalogs).not.toHaveBeenCalled();
  });

  it("still resets updatingDescription to false in finally on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const calls = mocks.setUpdatingDescription.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// ── (d) 401 — session expiry ───────────────────────────────────────────────────

describe("performUpdateDescription — 401 (session expired)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls logoutAdmin when the response is 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.logoutAdmin).toHaveBeenCalledTimes(1);
  });

  it("does NOT set an error message on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const nonNullErrors = mocks.setUpdateDescriptionError.mock.calls
      .filter(([v]: [string | null]) => v !== null);
    expect(nonNullErrors).toHaveLength(0);
  });

  it("does NOT close the modal on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
    expect(mocks.setDuplicateItem).not.toHaveBeenCalled();
  });

  it("still resets updatingDescription to false in finally on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performUpdateDescription(deps);

    const calls = mocks.setUpdatingDescription.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});
