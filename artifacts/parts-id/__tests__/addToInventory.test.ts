/**
 * @jest-environment node
 *
 * Unit tests for performAddToInventory (utils/addToInventory.ts).
 *
 * Covers:
 *   (a) URL correctness — the fetch must target /inventory/add-part (not an
 *       admin-prefixed or otherwise wrong path).
 *   (b) success — addedCatalogs is updated and the modal closes or the
 *       created item is surfaced.
 *   (c) vendor validation — empty vendor short-circuits before any fetch.
 *   (d) 409 conflict — existingItem surfaces the duplicate; error text is
 *       shown when there is no existingItem.
 *   (e) API error — addError is shown, state stays open.
 *   (f) Network failure — addError is shown with a generic message.
 *   (g) 401 response — logoutAdmin is called, no other state is mutated.
 */

import { performAddToInventory, AddToInventoryDeps, CreatedPart } from "../utils/addToInventory";

// ── fetch mock helpers ─────────────────────────────────────────────────────────

function makeOkResponse(item?: CreatedPart): Response {
  return {
    ok: true,
    status: 200,
    json: async () => (item ? { item } : {}),
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
  setAddingInProgress: jest.Mock;
  setAddError: jest.Mock;
  setDuplicateItem: jest.Mock;
  setAddedCatalogs: jest.Mock;
  setAddedItem: jest.Mock;
  setAddModalPart: jest.Mock;
};

const BASE_FORM = {
  vendor: "Acme Corp",
  catalog: "ACME-42",
  description: "Widget assembly",
  binLocation: "A-01",
};

function makeDeps(overrides: Partial<AddToInventoryDeps> = {}): { deps: AddToInventoryDeps; mocks: Mocks } {
  const mocks: Mocks = {
    logoutAdmin: jest.fn(),
    setAddingInProgress: jest.fn(),
    setAddError: jest.fn(),
    setDuplicateItem: jest.fn(),
    setAddedCatalogs: jest.fn(),
    setAddedItem: jest.fn(),
    setAddModalPart: jest.fn(),
  };

  const deps: AddToInventoryDeps = {
    apiBase: "https://example.com/api",
    authHeaders: { Authorization: "Bearer tok-abc" },
    addForm: { ...BASE_FORM },
    catalogNumber: "ACME-42",
    logoutAdmin: mocks.logoutAdmin,
    setAddingInProgress: mocks.setAddingInProgress,
    setAddError: mocks.setAddError,
    setDuplicateItem: mocks.setDuplicateItem,
    setAddedCatalogs: mocks.setAddedCatalogs,
    setAddedItem: mocks.setAddedItem,
    setAddModalPart: mocks.setAddModalPart,
    ...overrides,
  };

  return { deps, mocks };
}

// ── (a) URL correctness ────────────────────────────────────────────────────────

describe("performAddToInventory — URL correctness", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls fetch with /inventory/add-part (not /admin/inventory/add-part)", async () => {
    const { deps } = makeDeps();
    await performAddToInventory(deps);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toBe("https://example.com/api/inventory/add-part");
  });

  it("fails if the path is accidentally prefixed with /admin", async () => {
    const { deps } = makeDeps();
    await performAddToInventory(deps);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).not.toContain("/admin/inventory/add-part");
  });

  it("uses POST as the HTTP method", async () => {
    const { deps } = makeDeps();
    await performAddToInventory(deps);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("includes the Authorization header", async () => {
    const { deps } = makeDeps();
    await performAddToInventory(deps);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-abc");
  });

  it("sends the trimmed form fields in the request body", async () => {
    const { deps } = makeDeps({
      addForm: { vendor: "  Acme  ", catalog: "CAT-1", description: "desc", binLocation: "B-02" },
    });
    await performAddToInventory(deps);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.vendor).toBe("Acme");
    expect(body.catalog).toBe("CAT-1");
    expect(body.binLocation).toBe("B-02");
  });

  it("omits binLocation from the body when it is blank", async () => {
    const { deps } = makeDeps({
      addForm: { ...BASE_FORM, binLocation: "   " },
    });
    await performAddToInventory(deps);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(Object.prototype.hasOwnProperty.call(body, "binLocation")).toBe(false);
  });
});

// ── (b) Success path ───────────────────────────────────────────────────────────

describe("performAddToInventory — success", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("adds the catalogNumber to addedCatalogs on success", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps({ catalogNumber: "ACME-42" });
    await performAddToInventory(deps);

    expect(mocks.setAddedCatalogs).toHaveBeenCalledTimes(1);
    const updater = mocks.setAddedCatalogs.mock.calls[0][0] as (prev: Set<string>) => Set<string>;
    const result = updater(new Set(["OLD-1"]));
    expect(result.has("ACME-42")).toBe(true);
    expect(result.has("OLD-1")).toBe(true);
  });

  it("skips setAddedCatalogs when catalogNumber is null", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps({ catalogNumber: null });
    await performAddToInventory(deps);

    expect(mocks.setAddedCatalogs).not.toHaveBeenCalled();
  });

  it("calls setAddedItem when the response body includes an item", async () => {
    const item: CreatedPart = { id: 5, vendor: "Acme", catalog: "X-1", description: "d", binLocations: [] };
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse(item));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddedItem).toHaveBeenCalledWith(item);
    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
  });

  it("closes the modal (setAddModalPart) when the response body has no item", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddModalPart).toHaveBeenCalledTimes(1);
    expect(mocks.setAddedItem).not.toHaveBeenCalled();
  });

  it("sets addingInProgress true then false (via finally)", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const calls = mocks.setAddingInProgress.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[0]).toBe(true);
    expect(calls[calls.length - 1]).toBe(false);
  });

  it("clears any previous error at the start", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith(null);
  });

  it("does not call logoutAdmin on success", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeOkResponse());
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.logoutAdmin).not.toHaveBeenCalled();
  });
});

// ── (c) Vendor validation ──────────────────────────────────────────────────────

describe("performAddToInventory — vendor validation", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sets an error and does NOT call fetch when vendor is blank", async () => {
    global.fetch = jest.fn();
    const { deps, mocks } = makeDeps({
      addForm: { ...BASE_FORM, vendor: "   " },
    });
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Vendor is required.");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not set addingInProgress when vendor is blank", async () => {
    global.fetch = jest.fn();
    const { deps, mocks } = makeDeps({
      addForm: { ...BASE_FORM, vendor: "" },
    });
    await performAddToInventory(deps);

    expect(mocks.setAddingInProgress).not.toHaveBeenCalled();
  });
});

// ── (d) 409 conflict ──────────────────────────────────────────────────────────

describe("performAddToInventory — 409 conflict", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls setDuplicateItem when the server returns an existingItem", async () => {
    const existing: CreatedPart = { id: 3, vendor: "Old", catalog: "O-1", description: "old", binLocations: ["Z-9"] };
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(409, { existingItem: existing }),
    );
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setDuplicateItem).toHaveBeenCalledWith(existing);
    expect(mocks.setAddError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it("shows the server error text when 409 has no existingItem", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(409, { error: "Part number already in use." }),
    );
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Part number already in use.");
    expect(mocks.setDuplicateItem).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when 409 body has no error key", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(409, {}));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("This part already exists in inventory.");
  });

  it("still resets addingInProgress to false in finally on 409", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(409, {}));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const calls = mocks.setAddingInProgress.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// ── (e) API error path ─────────────────────────────────────────────────────────

describe("performAddToInventory — API error (non-ok response)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows the server error message on a non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      makeErrorResponse(422, { error: "Invalid catalog format." }),
    );
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Invalid catalog format.");
  });

  it("falls back to a generic message when the error body has no 'error' key", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(500, {}));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Failed to add part.");
  });

  it("falls back to a generic message when JSON parsing the error body fails", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonParseFailResponse(500));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Failed to add part.");
  });

  it("does NOT close the modal on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(422, {}));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
  });

  it("still resets addingInProgress to false in finally on API error", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(503, {}));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const calls = mocks.setAddingInProgress.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// ── (f) Network failure path ───────────────────────────────────────────────────

describe("performAddToInventory — network failure (fetch throws)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a generic network error message when fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddError).toHaveBeenCalledWith("Network error. Please try again.");
  });

  it("does NOT close the modal on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
  });

  it("still resets addingInProgress to false in finally on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const calls = mocks.setAddingInProgress.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});

// ── (g) 401 — session expiry ───────────────────────────────────────────────────

describe("performAddToInventory — 401 (session expired)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls logoutAdmin when the response is 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.logoutAdmin).toHaveBeenCalledTimes(1);
  });

  it("does NOT set an error message on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const nonNullErrors = mocks.setAddError.mock.calls
      .filter(([v]: [string | null]) => v !== null);
    expect(nonNullErrors).toHaveLength(0);
  });

  it("does NOT close the modal on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    expect(mocks.setAddModalPart).not.toHaveBeenCalled();
  });

  it("still resets addingInProgress to false in finally on 401", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeErrorResponse(401));
    const { deps, mocks } = makeDeps();
    await performAddToInventory(deps);

    const calls = mocks.setAddingInProgress.mock.calls.map(([v]: [boolean]) => v);
    expect(calls[calls.length - 1]).toBe(false);
  });
});
