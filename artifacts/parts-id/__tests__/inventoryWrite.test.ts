/**
 * Regression coverage for the inventory write lifecycle:
 * - a request that never settles still rejects at the write deadline;
 * - aborting the controller is part of the same timeout path.
 */

import { runInventoryWrite, INVENTORY_WRITE_TIMEOUT_MS } from "@/utils/inventoryWrite";

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