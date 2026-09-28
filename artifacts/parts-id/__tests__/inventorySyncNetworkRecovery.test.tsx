/**
 * @jest-environment node
 *
 * Exercises the production inventory-page request helper used by background
 * sync, including timeout retries and cancellation after the screen goes away.
 */

const mockFetchWithAuth = jest.fn();

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { fetchInventoryPageWithDeadline } from "../utils/inventorySync";
import { retryAsync } from "../utils/retryAsync";

function makeResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("inventory sync page network recovery", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it("times out a stalled page request, aborts it, and allows retry to succeed", async () => {
    const signals: AbortSignal[] = [];
    mockFetchWithAuth
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      })
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        signals.push(init.signal as AbortSignal);
        return Promise.resolve(makeResponse({ items: [{ id: 7 }], total: 1 }));
      });

    const controller = new AbortController();
    const result = await retryAsync(
      () => fetchInventoryPageWithDeadline<{ id: number }>(
        "/api/inventory?page=1&limit=500",
        controller.signal,
        15,
      ),
      { maxAttempts: 2, delayMs: 0 },
    );

    expect(result).toEqual({ items: [{ id: 7 }], total: 1 });
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("rejects promptly and aborts the request when sync is cancelled", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let resolveLateResponse: ((response: Response) => void) | undefined;
    mockFetchWithAuth.mockImplementation((_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveLateResponse = resolve;
      });
    });

    const request = fetchInventoryPageWithDeadline<{ id: number }>(
      "/api/inventory?page=1&limit=500",
      controller.signal,
      10_000,
    );
    await Promise.resolve();
    controller.abort(new DOMException("The operation was aborted.", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);

    // A late response from a transport that ignored abort cannot change the
    // already-cancelled sync result.
    resolveLateResponse?.(makeResponse({ items: [{ id: 7 }], total: 1 }));
  });
});