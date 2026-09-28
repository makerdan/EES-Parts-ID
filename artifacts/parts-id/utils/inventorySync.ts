import { fetchWithAuth } from "@/utils/appAuth";

const INVENTORY_PAGE_REQUEST_TIMEOUT_MS = 30_000;

type InventoryPage<T> = {
  items: Array<T>;
  total: number;
};

/**
 * Fetches one inventory page with a deadline covering both the response and
 * its JSON body. The parent sync signal cancels the request and rejects this
 * promise even if a transport or test double does not settle after abort.
 */
export async function fetchInventoryPageWithDeadline<T>(
  url: string,
  parentSignal: AbortSignal,
  timeoutMs = INVENTORY_PAGE_REQUEST_TIMEOUT_MS,
): Promise<InventoryPage<T>> {
  if (parentSignal.aborted) {
    throw parentSignal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  const requestController = new AbortController();
  const abortFromParent = () => {
    requestController.abort(
      parentSignal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  };
  parentSignal.addEventListener("abort", abortFromParent, { once: true });

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(
      requestController.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
    requestController.signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (requestController.signal.aborted) rejectOnAbort();
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new Error(`Inventory page request timed out after ${timeoutMs}ms`);
      timeoutError.name = "TimeoutError";
      requestController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  const request = (async (): Promise<InventoryPage<T>> => {
    const response = await fetchWithAuth(url, { signal: requestController.signal });
    if (!response.ok) throw new Error(`Sync failed: ${response.status}`);
    return await response.json() as InventoryPage<T>;
  })();

  try {
    return await Promise.race([request, deadline, aborted]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    parentSignal.removeEventListener("abort", abortFromParent);
    if (rejectOnAbort) requestController.signal.removeEventListener("abort", rejectOnAbort);
  }
}