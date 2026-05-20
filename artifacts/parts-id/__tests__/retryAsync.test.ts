/**
 * @jest-environment node
 *
 * Unit tests for the retryAsync utility.
 */
import { retryAsync } from "../utils/retryAsync";

describe("retryAsync", () => {
  it("resolves immediately when the function succeeds on the first attempt", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await retryAsync(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries and resolves when the function succeeds on a later attempt", async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "eventually ok";
    });

    const result = await retryAsync(fn, { maxAttempts: 3, delayMs: 0 });
    expect(result).toBe("eventually ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rejects with the last error after all attempts are exhausted", async () => {
    let calls = 0;
    const fn = jest.fn().mockImplementation(async () => {
      calls++;
      throw new Error(calls < 3 ? `fail ${calls}` : "still failing");
    });

    await expect(retryAsync(fn, { maxAttempts: 3, delayMs: 0 })).rejects.toThrow(
      "still failing",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects maxAttempts: 1 — no retries", async () => {
    const fn = jest.fn().mockImplementation(async () => {
      throw new Error("boom");
    });
    await expect(retryAsync(fn, { maxAttempts: 1, delayMs: 0 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the attempt index (0-based) to the function", async () => {
    const indices: number[] = [];
    const fn = jest.fn().mockImplementation(async (attempt: number) => {
      indices.push(attempt);
      if (attempt < 2) throw new Error("not yet");
      return "done";
    });

    await retryAsync(fn, { maxAttempts: 3, delayMs: 0 });
    expect(indices).toEqual([0, 1, 2]);
  });
});
