/**
 * Regression coverage for the inventory write lifecycle:
 * - a request that never settles still rejects at the write deadline;
 * - aborting the controller is part of the same timeout path.
 */

import type { InventoryItem } from "@workspace/api-client-react";

import {
  applySuccessfulInventoryFields,
  INVENTORY_WRITE_TIMEOUT_MS,
  resolveInventorySaveResults,
  runInventoryWrite,
} from "@/utils/inventoryWrite";

describe("runInventoryWrite", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not leave a never-resolving request pending forever", async () => {
    jest.useFakeTimers();
    const controllers = new Set<AbortController>();
    let signal: AbortSignal | undefined;

    const pending = runInventoryWrite(controllers, requestSignal => {
      signal = requestSignal;
      return new Promise<void>(() => { /* deliberately never settles */ });
    });

    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      timeoutMs: INVENTORY_WRITE_TIMEOUT_MS,
    });
    await jest.advanceTimersByTimeAsync(INVENTORY_WRITE_TIMEOUT_MS);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(controllers.size).toBe(0);
  });
});


describe("shared inventory save-result handling", () => {
  it("keeps successful fields committed and restores only rejected fields", () => {
    const restoreDescription = jest.fn();
    const restoreBins = jest.fn();
    const resolution = resolveInventorySaveResults(
      [
        { field: "description", promise: Promise.resolve(), restoreFn: restoreDescription },
        { field: "bins", promise: Promise.resolve(), restoreFn: restoreBins },
      ],
      [
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: new Error("Bin write failed") },
      ],
    );

    expect([...resolution.succeededFields]).toEqual(["description"]);
    expect(resolution.fieldErrors).toEqual({ bins: "Bin write failed" });
    expect(resolution.message).toBe("Description saved · Bins failed — check connection and retry");
    expect(restoreDescription).not.toHaveBeenCalled();
    expect(restoreBins).toHaveBeenCalledTimes(1);
  });

  it("builds a partial item from exactly the successful field patches", () => {
    const current = {
      id: 42,
      description: "Old",
      binLocations: ["A1"],
    } as InventoryItem;

    expect(applySuccessfulInventoryFields(
      current,
      new Set(["description"]),
      {
        description: { description: "New" },
        bins: { binLocations: ["B2"] },
      },
    )).toEqual({
      ...current,
      description: "New",
      binLocations: ["A1"],
    });
  });
});