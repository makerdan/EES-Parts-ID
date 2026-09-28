import type { InventoryItem } from "@workspace/api-client-react";

const mockInvalidateAllCachesAfterSave = jest.fn().mockResolvedValue({
  ok: true,
  failures: [],
});

jest.mock("@workspace/api-client-react", () => ({
  getListInventoryQueryKey: jest.fn(() => ["inventory"]),
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateAllCachesAfterSave: (...args: unknown[]) => mockInvalidateAllCachesAfterSave(...args),
}));

import {
  coordinateSharedPartSave,
  normalizeSharedPartDraft,
  type SharedPartSaveCacheContext,
} from "@/utils/sharedPartSaveCoordinator";

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 42,
    catalog: "PART-X",
    description: "Old description",
    binLocations: ["A1"],
    barcodes: ["111"],
    aiKeywords: ["old"],
    orderPurchase: 1,
    orderQuantity: 2,
    totalOpOq: 3,
    dimensions: { length: 1, width: null, height: null, diameter: null },
    imageUrl: null,
    imageUrl2: null,
    ...overrides,
  } as InventoryItem;
}

function makeCache() {
  const restored: Array<[unknown, unknown]> = [];
  const inventory = [["inventory", { page: 1 }], { items: [{ id: 42 }] }] as [unknown, unknown];
  const search = [["searchInventory", { keywords: "part" }], { results: [{ item: { id: 42 } }] }] as [unknown, unknown];
  const queryClient = {
    getQueriesData: jest.fn((filter: { predicate: (q: { queryKey: unknown }) => boolean }) =>
      filter.predicate({ queryKey: inventory[0] }) ? [inventory] : [search],
    ),
    setQueryData: jest.fn((key: unknown, value: unknown) => {
      restored.push([key, value]);
    }),
    setQueriesData: jest.fn(),
    invalidateQueries: jest.fn().mockResolvedValue(undefined),
  };
  return {
    queryClient: queryClient as unknown as SharedPartSaveCacheContext["queryClient"],
    restored,
    asyncStorage: {
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    },
  };
}

function draft(overrides: Partial<Parameters<typeof coordinateSharedPartSave>[0]["draft"]> = {}) {
  return {
    description: "  New description ",
    bins: ["A1"],
    pendingBin: "B2",
    barcodes: ["111"],
    pendingBarcode: "222",
    keywords: ["Old"],
    pendingKeyword: "Breaker",
    op: "4",
    oq: "5",
    dimensions: { length: "2.04", width: "", height: null, diameter: null },
    ...overrides,
  };
}

describe("coordinateSharedPartSave", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvalidateAllCachesAfterSave.mockResolvedValue({ ok: true, failures: [] });
  });

  it("normalizes pending values once and suppresses invalid order writes", () => {
    const result = normalizeSharedPartDraft({
      ...draft(),
      op: "-1",
      oq: "1.5",
    });

    expect(result.normalized).toMatchObject({
      description: "New description",
      bins: ["A1", "B2"],
      barcodes: ["111", "222"],
      keywords: ["old", "breaker"],
      dimensions: { length: 2, width: null, height: null, diameter: null },
    });
    expect(result.invalidFields).toEqual({
      opoq: "OP and OQ must be non-negative whole numbers.",
    });
  });

  it.each(["-12.5", "1..2", "100001"])(
    "rejects malformed shared dimension input %s instead of normalizing it",
    (value) => {
      expect(() =>
        normalizeSharedPartDraft(draft({
          dimensions: { length: value, width: "", height: "", diameter: "" },
        })),
      ).toThrow("Enter a non-negative number up to 100,000");
    },
  );

  it("pairs out-of-order settlements by field and commits server-returned values", async () => {
    const cache = makeCache();
    let resolveDescription!: (item: InventoryItem) => void;
    let resolveBins!: (item: InventoryItem) => void;
    const writes = {
      description: jest.fn(() => new Promise<InventoryItem>(resolve => { resolveDescription = resolve; })),
      bins: jest.fn(() => new Promise<InventoryItem>(resolve => { resolveBins = resolve; })),
    };
    const saving = coordinateSharedPartSave({
      current: makeItem(),
      draft: draft({
        barcodes: ["111"],
        pendingBarcode: "",
        keywords: ["old"],
        pendingKeyword: "",
        op: "1",
        oq: "2",
        dimensions: { length: "1", width: "", height: "", diameter: "" },
      }),
      writers: writes,
      cache,
    });

    await Promise.resolve();
    resolveBins(makeItem({ binLocations: ["SERVER-BIN"] }));
    resolveDescription(makeItem({ description: "SERVER DESCRIPTION" }));
    const result = await saving;

    expect(result.operations).toEqual(["description", "bins"]);
    expect(result.succeededFields).toEqual(new Set(["description", "bins"]));
    expect(result.committedItem.description).toBe("SERVER DESCRIPTION");
    expect(result.committedItem.binLocations).toEqual(["SERVER-BIN"]);
    expect(result.committedItem.aiKeywords).toEqual(["old"]);
    expect(result.outcomes.description?.status).toBe("fulfilled");
    expect(result.outcomes.bins?.status).toBe("fulfilled");
  });

  it("restores snapshots, keeps successful fields, and retries only failed fields", async () => {
    const cache = makeCache();
    const description = jest.fn().mockResolvedValue(makeItem({ description: "SERVER" }));
    const bins = jest.fn()
      .mockRejectedValueOnce(new Error("bin unavailable"))
      .mockResolvedValueOnce(makeItem({ binLocations: ["SERVER-BIN"] }));
    const first = await coordinateSharedPartSave({
      current: makeItem(),
      draft: draft({
        barcodes: ["111"],
        pendingBarcode: "",
        keywords: ["old"],
        pendingKeyword: "",
        op: "1",
        oq: "2",
        dimensions: { length: "1", width: "", height: "", diameter: "" },
      }),
      writers: { description, bins },
      cache,
    });

    expect(first.succeededFields).toEqual(new Set(["description"]));
    expect(first.failedFields).toEqual(new Set(["bins"]));
    expect(first.committedItem.description).toBe("SERVER");
    expect(first.committedItem.binLocations).toEqual(["A1"]);
    expect(first.retryableDrafts.bins).toEqual(["A1", "B2"]);
    expect(cache.queryClient.setQueryData).toHaveBeenCalledTimes(2);

    const second = await coordinateSharedPartSave({
      current: first.committedItem,
      draft: draft({
        description: "SERVER",
        bins: ["A1", "B2"],
        pendingBin: "",
        barcodes: ["111"],
        pendingBarcode: "",
        keywords: ["old"],
        pendingKeyword: "",
        op: "1",
        oq: "2",
        dimensions: { length: "1", width: "", height: "", diameter: "" },
      }),
      writers: { description, bins },
      cache: makeCache(),
    });

    expect(description).toHaveBeenCalledTimes(1);
    expect(bins).toHaveBeenCalledTimes(2);
    expect(second.failedFields.size).toBe(0);
    expect(second.committedItem.binLocations).toEqual(["SERVER-BIN"]);
  });

  it("does not invoke writers for an invalid order draft", async () => {
    const cache = makeCache();
    const writers = { description: jest.fn(), opoq: jest.fn() };
    const result = await coordinateSharedPartSave({
      current: makeItem(),
      draft: draft({ op: "1.2" }),
      writers,
      cache,
    });

    expect(result.anyFailed).toBe(true);
    expect(result.failedFields).toEqual(new Set(["opoq"]));
    expect(writers.description).not.toHaveBeenCalled();
    expect(writers.opoq).not.toHaveBeenCalled();
    expect(mockInvalidateAllCachesAfterSave).not.toHaveBeenCalled();
  });
});