/**
 * @jest-environment node
 *
 * Guards the post-save list-cache invalidation contract for every screen that
 * edits inventory items outside the main Edit Part flow:
 *
 *   Screen              Handler function
 *   ──────────────────  ──────────────────────────────────────────────
 *   BinEditor           saveBinsAndInvalidate
 *   BarcodeEditor       saveBarcodesAndInvalidate
 *   BulkShelfAssign     invalidateListIfNew  (assign path, wasNew=true)
 *   BulkShelfAssign     invalidateListIfNew  (assign path, wasNew=false)
 *   BulkShelfAssign     undoBarcodeAndInvalidate  (undo path)
 *   ShelfCatalogEntry   invalidateInventoryList
 *
 * Each test calls the REAL production handler function from
 * utils/listEditorHandlers.ts — the same code the component's useCallback
 * delegates to — while mocking `invalidateListCache` from editItemCache to
 * intercept the eventual queryClient.invalidateQueries call.
 *
 * If `invalidateListCache` is dropped from any handler the corresponding test
 * fails immediately, regardless of whether the component renders.
 */

// ── Mock editItemCache BEFORE any imports ────────────────────────────────────
// jest.mock is hoisted so this intercepts the import inside listEditorHandlers.

const mockInvalidateListCache = jest.fn<Promise<void>, [{ queryClient: unknown }]>();

jest.mock("../utils/editItemCache", () => ({
  invalidateListCache: (...args: [{ queryClient: unknown }]) =>
    mockInvalidateListCache(...args),
}));

// ── Import production handlers AFTER mock is declared ────────────────────────

import {
  saveBinsAndInvalidate,
  saveBarcodesAndInvalidate,
  invalidateListIfNew,
  undoBarcodeAndInvalidate,
  invalidateInventoryList,
} from "../utils/listEditorHandlers";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fakeQueryClient = { invalidateQueries: jest.fn() };

/** Simulate a successful mutateAsync that returns the given payload. */
function makeMutate<T>(result: T): jest.Mock<Promise<T>> {
  return jest.fn().mockResolvedValue(result);
}

// ── Per-test setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockInvalidateListCache.mockResolvedValue(undefined);
});

// =============================================================================
// BinEditor — saveBinsAndInvalidate
// =============================================================================

describe("BinEditor: saveBinsAndInvalidate", () => {
  it("calls invalidateListCache after a successful mutation", async () => {
    const mutateAsync = makeMutate({ binLocations: ["A-01", "B-02"] });

    await saveBinsAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 10,
      bins: ["A-01", "B-02"],
    });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateListCache).toHaveBeenCalledWith({
      queryClient: fakeQueryClient,
    });
  });

  it("passes the correct payload to mutateAsync", async () => {
    const mutateAsync = makeMutate({ binLocations: ["C-03"] });

    await saveBinsAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 42,
      bins: ["C-03"],
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 42,
      data: { binLocations: ["C-03"] },
    });
  });

  it("returns the server-confirmed binLocations", async () => {
    const mutateAsync = makeMutate({ binLocations: ["X-01"] });

    const result = await saveBinsAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 1,
      bins: ["X-01"],
    });

    expect(result.binLocations).toEqual(["X-01"]);
  });

  it("does NOT call invalidateListCache when mutateAsync throws", async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error("network error"));

    await expect(
      saveBinsAndInvalidate({
        queryClient: fakeQueryClient,
        mutateAsync,
        itemId: 5,
        bins: ["A-01"],
      })
    ).rejects.toThrow("network error");

    expect(mockInvalidateListCache).not.toHaveBeenCalled();
  });
});

// =============================================================================
// BarcodeEditor — saveBarcodesAndInvalidate
// =============================================================================

describe("BarcodeEditor: saveBarcodesAndInvalidate", () => {
  it("calls invalidateListCache after a successful mutation", async () => {
    const mutateAsync = makeMutate({ barcodes: ["123456", "789012"] });

    await saveBarcodesAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 20,
      barcodes: ["123456", "789012"],
    });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateListCache).toHaveBeenCalledWith({
      queryClient: fakeQueryClient,
    });
  });

  it("passes the correct payload to mutateAsync", async () => {
    const mutateAsync = makeMutate({ barcodes: ["ABC"] });

    await saveBarcodesAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 99,
      barcodes: ["ABC"],
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 99,
      data: { barcodes: ["ABC"] },
    });
  });

  it("returns the server-confirmed barcodes", async () => {
    const mutateAsync = makeMutate({ barcodes: ["QR99"] });

    const result = await saveBarcodesAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 3,
      barcodes: ["QR99"],
    });

    expect(result.barcodes).toEqual(["QR99"]);
  });

  it("does NOT call invalidateListCache when mutateAsync throws", async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error("timeout"));

    await expect(
      saveBarcodesAndInvalidate({
        queryClient: fakeQueryClient,
        mutateAsync,
        itemId: 7,
        barcodes: ["XYZ"],
      })
    ).rejects.toThrow("timeout");

    expect(mockInvalidateListCache).not.toHaveBeenCalled();
  });
});

// =============================================================================
// BulkShelfAssign — invalidateListIfNew (performAssign path)
// =============================================================================

describe("BulkShelfAssign performAssign: invalidateListIfNew", () => {
  it("calls invalidateListCache when wasNew is true", async () => {
    await invalidateListIfNew({ queryClient: fakeQueryClient, wasNew: true });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateListCache).toHaveBeenCalledWith({
      queryClient: fakeQueryClient,
    });
  });

  it("does NOT call invalidateListCache when wasNew is false", async () => {
    await invalidateListIfNew({ queryClient: fakeQueryClient, wasNew: false });

    expect(mockInvalidateListCache).not.toHaveBeenCalled();
  });
});

// =============================================================================
// BulkShelfAssign — undoBarcodeAndInvalidate (handleUndoAssignment path)
// =============================================================================

describe("BulkShelfAssign handleUndoAssignment: undoBarcodeAndInvalidate", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeItem(id: number, barcodes: string[]): any {
    return { id, vendor: "V", catalog: "C", description: "D", barcodes, binLocations: [] };
  }

  it("calls invalidateListCache after the mutation succeeds", async () => {
    const mutateAsync = makeMutate(makeItem(55, ["REMAIN"]));

    await undoBarcodeAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 55,
      currentBarcodes: ["REMAIN", "REVOKE"],
      revokedBarcode: "REVOKE",
    });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateListCache).toHaveBeenCalledWith({
      queryClient: fakeQueryClient,
    });
  });

  it("removes the revoked barcode before calling mutateAsync", async () => {
    const mutateAsync = makeMutate(makeItem(7, ["A", "C"]));

    await undoBarcodeAndInvalidate({
      queryClient: fakeQueryClient,
      mutateAsync,
      itemId: 7,
      currentBarcodes: ["A", "B", "C"],
      revokedBarcode: "B",
    });

    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      data: { barcodes: ["A", "C"] },
    });
  });

  it("does NOT call invalidateListCache when mutateAsync throws", async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error("server error"));

    await expect(
      undoBarcodeAndInvalidate({
        queryClient: fakeQueryClient,
        mutateAsync,
        itemId: 8,
        currentBarcodes: ["X"],
        revokedBarcode: "X",
      })
    ).rejects.toThrow("server error");

    expect(mockInvalidateListCache).not.toHaveBeenCalled();
  });
});

// =============================================================================
// ShelfCatalogEntry — invalidateInventoryList (invalidateInventory callback)
// =============================================================================

describe("ShelfCatalogEntry: invalidateInventoryList", () => {
  it("calls invalidateListCache", async () => {
    await invalidateInventoryList({ queryClient: fakeQueryClient });

    expect(mockInvalidateListCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateListCache).toHaveBeenCalledWith({
      queryClient: fakeQueryClient,
    });
  });

  it("resolves without throwing", async () => {
    await expect(
      invalidateInventoryList({ queryClient: fakeQueryClient })
    ).resolves.toBeUndefined();
  });
});

// =============================================================================
// invalidateListCache contract — predicate correctness
// (kept here as the authoritative guard for the shared predicate logic)
// =============================================================================

describe("invalidateListCache contract (real implementation, no mock)", () => {
  /**
   * Use jest.requireActual to bypass the module-level mock and exercise the
   * real implementation so we can verify the predicate shape passed to
   * queryClient.invalidateQueries.
   */
  const { invalidateListCache: realInvalidateListCache } = jest.requireActual(
    "../utils/editItemCache",
  ) as typeof import("../utils/editItemCache");

  it("calls invalidateQueries with a predicate function", async () => {
    const iq = jest.fn().mockResolvedValue(undefined);
    await realInvalidateListCache({ queryClient: { invalidateQueries: iq } });
    const [arg] = iq.mock.calls[0] as [{ predicate?: unknown }];
    expect(typeof arg.predicate).toBe("function");
  });

  it("predicate matches all /api/inventory list queries", async () => {
    const iq = jest.fn().mockResolvedValue(undefined);
    await realInvalidateListCache({ queryClient: { invalidateQueries: iq } });
    const predicate = (iq.mock.calls[0] as [
      { predicate: (q: { queryKey: unknown }) => boolean },
    ])[0].predicate;

    expect(predicate({ queryKey: ["/api/inventory"] })).toBe(true);
    expect(predicate({ queryKey: ["/api/inventory", { page: 1, limit: 50 }] })).toBe(true);
    expect(predicate({ queryKey: ["/api/inventory", { binPrefix: "08-01" }] })).toBe(true);
  });

  it("predicate does NOT match search or unrelated keys", async () => {
    const iq = jest.fn().mockResolvedValue(undefined);
    await realInvalidateListCache({ queryClient: { invalidateQueries: iq } });
    const predicate = (iq.mock.calls[0] as [
      { predicate: (q: { queryKey: unknown }) => boolean },
    ])[0].predicate;

    expect(predicate({ queryKey: ["searchInventory"] })).toBe(false);
    expect(predicate({ queryKey: ["searchInventory", { keywords: "relay" }] })).toBe(false);
    expect(predicate({ queryKey: [] })).toBe(false);
    expect(predicate({ queryKey: ["unrelated"] })).toBe(false);
  });
});
