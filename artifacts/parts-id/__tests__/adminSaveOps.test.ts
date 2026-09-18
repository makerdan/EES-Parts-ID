/**
 * Unit tests for adminSaveUtils.ts — pure utility functions extracted from
 * the admin handleSave path.
 *
 * All functions are dependency-free so no mocking is required.  Tests run
 * entirely in-process with plain inputs and outputs.
 */

import {
  buildFinalBins,
  buildFinalKeywords,
  buildNewDims,
  buildPatchedItem,
  checkDimsChanged,
  executeSaveOps,
  parseDimField,
} from "../utils/adminSaveUtils";
import type { PartDimensions, SaveOp } from "../utils/adminSaveUtils";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDims(
  overrides: Partial<PartDimensions> = {},
): PartDimensions {
  return { length: null, width: null, height: null, diameter: null, ...overrides };
}

type MinItem = {
  id: number;
  description: string | null;
  binLocations: string[];
  aiKeywords: string[];
  dimensions?: PartDimensions | null;
  imageUrl?: string | null;
  imageUrl2?: string | null;
};

function makeItem(overrides: Partial<MinItem> = {}): MinItem {
  return {
    id: 42,
    description: "original",
    binLocations: ["A1"],
    aiKeywords: ["motor"],
    dimensions: null,
    imageUrl: null,
    imageUrl2: null,
    ...overrides,
  };
}

// =============================================================================
// parseDimField
// =============================================================================

describe("parseDimField", () => {
  it("parses a positive number string", () => {
    expect(parseDimField("50")).toBe(50);
  });

  it("rounds to one decimal place", () => {
    expect(parseDimField("12.34")).toBe(12.3);
  });

  it("returns null for NaN input", () => {
    expect(parseDimField("abc")).toBeNull();
  });

  it("returns null for negative values", () => {
    expect(parseDimField("-1")).toBeNull();
  });

  it("returns 0 for '0'", () => {
    expect(parseDimField("0")).toBe(0);
  });

  it("returns null for empty string", () => {
    expect(parseDimField("")).toBeNull();
  });
});

// =============================================================================
// buildFinalBins
// =============================================================================

describe("buildFinalBins", () => {
  it("adds a new bin that is not yet in the list", () => {
    expect(buildFinalBins(["A1"], "B2")).toEqual(["A1", "B2"]);
  });

  it("does not add a duplicate (exact match)", () => {
    const result = buildFinalBins(["A1", "B2"], "A1");
    expect(result).toEqual(["A1", "B2"]);
  });

  it("does not add a case-insensitive duplicate", () => {
    const result = buildFinalBins(["A1"], "a1");
    expect(result).toEqual(["A1"]);
  });

  it("returns the same array reference when pending is empty", () => {
    const bins = ["A1"];
    const result = buildFinalBins(bins, "");
    expect(result).toBe(bins);
  });

  it("returns the same array reference when pending is whitespace only", () => {
    const bins = ["A1"];
    const result = buildFinalBins(bins, "   ");
    expect(result).toBe(bins);
  });

  it("adds to an initially-empty array", () => {
    expect(buildFinalBins([], "A1")).toEqual(["A1"]);
  });
});

// =============================================================================
// buildFinalKeywords
// =============================================================================

describe("buildFinalKeywords", () => {
  it("adds a new keyword (lowercased)", () => {
    expect(buildFinalKeywords(["motor"], "AC")).toEqual(["motor", "ac"]);
  });

  it("does not add a duplicate keyword", () => {
    expect(buildFinalKeywords(["motor", "ac"], "AC")).toEqual(["motor", "ac"]);
  });

  it("returns the same array when pending is empty", () => {
    const kw = ["motor"];
    expect(buildFinalKeywords(kw, "")).toBe(kw);
  });

  it("returns the same array when pending is whitespace only", () => {
    const kw = ["motor"];
    expect(buildFinalKeywords(kw, "  ")).toBe(kw);
  });

  it("adds to an initially-empty array", () => {
    expect(buildFinalKeywords([], "motor")).toEqual(["motor"]);
  });
});

// =============================================================================
// buildNewDims
// =============================================================================

describe("buildNewDims", () => {
  it("parses all four fields", () => {
    expect(buildNewDims("10", "20", "30", "5")).toEqual({
      length: 10,
      width: 20,
      height: 30,
      diameter: 5,
    });
  });

  it("sets null for invalid / blank fields", () => {
    expect(buildNewDims("", "abc", "-1", "0")).toEqual({
      length: null,
      width: null,
      height: null,
      diameter: 0,
    });
  });
});

// =============================================================================
// checkDimsChanged
// =============================================================================

describe("checkDimsChanged", () => {
  it("returns false when all fields match existing dims", () => {
    const newDims = makeDims({ length: 50, width: 30 });
    const existing = { length: 50, width: 30, height: null, diameter: null };
    expect(checkDimsChanged(newDims, existing)).toBe(false);
  });

  it("returns true when length differs", () => {
    const newDims = makeDims({ length: 99 });
    const existing = { length: 50, width: null, height: null, diameter: null };
    expect(checkDimsChanged(newDims, existing)).toBe(true);
  });

  it("returns true when width differs", () => {
    expect(checkDimsChanged(makeDims({ width: 10 }), { length: null, width: null, height: null, diameter: null })).toBe(true);
  });

  it("returns true when height differs", () => {
    expect(checkDimsChanged(makeDims({ height: 10 }), { length: null, width: null, height: null, diameter: null })).toBe(true);
  });

  it("returns true when diameter differs", () => {
    expect(checkDimsChanged(makeDims({ diameter: 5 }), { length: null, width: null, height: null, diameter: null })).toBe(true);
  });

  it("treats null existing as all-null dims (no-change when newDims is all-null)", () => {
    expect(checkDimsChanged(makeDims(), null)).toBe(false);
  });

  it("treats undefined existing as all-null dims", () => {
    expect(checkDimsChanged(makeDims(), undefined)).toBe(false);
  });

  it("returns true when existing is null but newDims has values", () => {
    expect(checkDimsChanged(makeDims({ length: 50 }), null)).toBe(true);
  });
});

// =============================================================================
// buildPatchedItem
// =============================================================================

describe("buildPatchedItem", () => {
  it("returns the item unchanged when id does not match targetId", () => {
    const item = makeItem({ id: 1 });
    const result = buildPatchedItem(item, {
      targetId: 99,
      description: "new",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims(),
    });
    expect(result).toBe(item);
  });

  it("patches description, bins, and keywords on the matching item", () => {
    const item = makeItem({ id: 42 });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "updated",
      binLocations: ["B2"],
      aiKeywords: ["ac", "motor"],
      dimsChanged: false,
      newDims: makeDims(),
    });
    expect(result.description).toBe("updated");
    expect(result.binLocations).toEqual(["B2"]);
    expect(result.aiKeywords).toEqual(["ac", "motor"]);
  });

  it("spreads dimensions when dimsChanged is true", () => {
    const item = makeItem({ id: 42, dimensions: null });
    const newDims = makeDims({ length: 50 });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: true,
      newDims,
    });
    expect(result.dimensions).toEqual(newDims);
  });

  it("preserves existing dimensions when dimsChanged is false", () => {
    const existingDims = makeDims({ length: 100 });
    const item = makeItem({ id: 42, dimensions: existingDims });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims({ length: 999 }), // should be ignored
    });
    expect(result.dimensions).toEqual(existingDims);
  });

  it("sets imageUrl when capturedImageUrl is provided", () => {
    const item = makeItem({ id: 42 });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims(),
      capturedImageUrl: "https://gcs.example.com/new.jpg",
    });
    expect(result.imageUrl).toBe("https://gcs.example.com/new.jpg");
  });

  it("sets imageUrl to null when capturedImageUrl is null (remove)", () => {
    const item = makeItem({ id: 42, imageUrl: "https://old.example.com/img.jpg" });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims(),
      capturedImageUrl: null,
    });
    expect(result.imageUrl).toBeNull();
  });

  it("does not set imageUrl when capturedImageUrl is undefined (no photo op)", () => {
    const item = makeItem({ id: 42, imageUrl: "https://existing.example.com/img.jpg" });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims(),
    });
    expect(result.imageUrl).toBe("https://existing.example.com/img.jpg");
  });

  it("sets imageUrl2 when capturedImageUrl2 is provided", () => {
    const item = makeItem({ id: 42 });
    const result = buildPatchedItem(item, {
      targetId: 42,
      description: "x",
      binLocations: [],
      aiKeywords: [],
      dimsChanged: false,
      newDims: makeDims(),
      capturedImageUrl2: "https://gcs.example.com/slot2.jpg",
    });
    expect(result.imageUrl2).toBe("https://gcs.example.com/slot2.jpg");
  });

  it("hasChanges is false after save — patched item fields match new UI state", () => {
    const capturedUrl = "https://gcs.example.com/new.jpg";
    const item = makeItem({ id: 42, description: "old", imageUrl: null });

    const patched = buildPatchedItem(item, {
      targetId: 42,
      description: "new",
      binLocations: ["A1", "B2"],
      aiKeywords: ["motor", "ac"],
      dimsChanged: false,
      newDims: makeDims(),
      capturedImageUrl: capturedUrl,
    });

    // Simulates: after save, the edit screen compares UI state against the
    // patched item.  If they match, hasChanges should be false.
    expect(patched.description).toBe("new");
    expect(patched.binLocations).toEqual(["A1", "B2"]);
    expect(patched.aiKeywords).toEqual(["motor", "ac"]);
    expect(patched.imageUrl).toBe(capturedUrl);
    expect(patched.dimensions).toBeNull(); // preserved (dimsChanged: false)
  });
});

// =============================================================================
// executeSaveOps
// =============================================================================

describe("executeSaveOps", () => {
  it("returns anyFailed=false and empty fieldErrors when all ops succeed", async () => {
    const ops: SaveOp[] = [
      { field: "description", promise: Promise.resolve("ok"), restoreFn: jest.fn() },
      { field: "bins", promise: Promise.resolve("ok"), restoreFn: jest.fn() },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(false);
    expect(result.fieldErrors).toEqual({});
    expect(ops[0]!.restoreFn).not.toHaveBeenCalled();
    expect(ops[1]!.restoreFn).not.toHaveBeenCalled();
  });

  it("calls restoreFn and sets fieldErrors for a failed op", async () => {
    const restoreFn = jest.fn();
    const ops: SaveOp[] = [
      {
        field: "description",
        promise: Promise.reject(new Error("timeout")),
        restoreFn,
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(true);
    expect(result.fieldErrors.description).toMatch(/connection/i);
    expect(restoreFn).toHaveBeenCalledTimes(1);
  });

  it("handles partial failure — only failed ops call restoreFn", async () => {
    const restoreGood = jest.fn();
    const restoreBad = jest.fn();
    const ops: SaveOp[] = [
      { field: "description", promise: Promise.resolve(), restoreFn: restoreGood },
      {
        field: "bins",
        promise: Promise.reject(new Error("network down")),
        restoreFn: restoreBad,
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(true);
    expect(result.fieldErrors.bins).toBeDefined();
    expect(result.fieldErrors.description).toBeUndefined();
    expect(restoreGood).not.toHaveBeenCalled();
    expect(restoreBad).toHaveBeenCalledTimes(1);
  });

  it("produces 'session expired' message for 401 errors", async () => {
    const ops: SaveOp[] = [
      {
        field: "photo",
        promise: Promise.reject(new Error("HTTP 401")),
        restoreFn: jest.fn(),
      },
    ];

    const result = await executeSaveOps(ops);

    expect(result.fieldErrors.photo).toMatch(/session expired/i);
  });

  it("handles all ops failing simultaneously", async () => {
    const restores = [jest.fn(), jest.fn(), jest.fn()];
    const ops: SaveOp[] = [
      { field: "description", promise: Promise.reject(new Error("err")), restoreFn: restores[0]! },
      { field: "bins", promise: Promise.reject(new Error("err")), restoreFn: restores[1]! },
      { field: "photo", promise: Promise.reject(new Error("err")), restoreFn: restores[2]! },
    ];

    const result = await executeSaveOps(ops);

    expect(result.anyFailed).toBe(true);
    expect(Object.keys(result.fieldErrors)).toHaveLength(3);
    restores.forEach((r) => expect(r).toHaveBeenCalledTimes(1));
  });

  it("returns anyFailed=false for an empty ops list", async () => {
    const result = await executeSaveOps([]);
    expect(result.anyFailed).toBe(false);
    expect(result.fieldErrors).toEqual({});
  });
});
