import type { InventoryItem } from "@workspace/api-client-react";

export const INVENTORY_WRITE_TIMEOUT_MS = 10_000;

export type InventorySaveField =
  | "description"
  | "bins"
  | "barcodes"
  | "keywords"
  | "dimensions"
  | "opoq"
  | "photo"
  | "photo2";

export type InventorySaveOp = {
  field: InventorySaveField;
  promise: Promise<unknown>;
  restoreFn: () => void;
};

export type InventorySaveResolution = {
  anyFailed: boolean;
  fieldErrors: Partial<Record<InventorySaveField, string>>;
  message: string | null;
  succeededFields: Set<InventorySaveField>;
};

const INVENTORY_SAVE_FIELD_LABELS: Record<InventorySaveField, string> = {
  description: "Description",
  bins: "Bins",
  barcodes: "Barcodes",
  keywords: "Keywords",
  dimensions: "Dimensions",
  opoq: "OP/OQ",
  photo: "Photo 1",
  photo2: "Photo 2",
};

class InventoryWriteTimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function inventorySaveErrorMessage(
  error: unknown,
  fallback = "Could not save — check connection and retry",
  options: { preserveServerMessage?: boolean } = {},
): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Save timed out — check connection and retry";
  }
  if (error instanceof Error && (error.name === "TypeError" || /network|offline|failed to fetch/i.test(error.message))) {
    return "Offline or connection lost — reconnect and retry";
  }
  if (error instanceof Error && error.message.includes("401")) {
    return "Session expired — re-unlock admin access";
  }
  if (options.preserveServerMessage !== false && error instanceof Error && error.message && !/^HTTP 5\d\d\b/.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export function resolveInventorySaveResults(
  ops: ReadonlyArray<InventorySaveOp>,
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): InventorySaveResolution {
  const succeededFields = new Set<InventorySaveField>();
  const fieldErrors: Partial<Record<InventorySaveField, string>> = {};

  results.forEach((result, index) => {
    const op = ops[index];
    if (!op) return;
    if (result.status === "fulfilled") {
      succeededFields.add(op.field);
      return;
    }
    op.restoreFn();
    fieldErrors[op.field] = inventorySaveErrorMessage(result.reason);
  });

  const failedFields = Object.keys(fieldErrors) as Array<InventorySaveField>;
  if (failedFields.length === 0) {
    return { anyFailed: false, fieldErrors, message: null, succeededFields };
  }

  const savedLabels = [...succeededFields].map((field) => INVENTORY_SAVE_FIELD_LABELS[field]);
  const failedLabels = failedFields.map((field) => INVENTORY_SAVE_FIELD_LABELS[field]);
  const parts: Array<string> = [];
  if (savedLabels.length > 0) parts.push(`${savedLabels.join(", ")} saved`);
  parts.push(`${failedLabels.join(", ")} failed`);

  const sessionExpired = Object.values(fieldErrors).some((message) => message?.includes("Session expired"));
  return {
    anyFailed: true,
    fieldErrors,
    message: sessionExpired
      ? "Admin session expired. Re-unlock and try again."
      : `${parts.join(" · ")} — check connection and retry`,
    succeededFields,
  };
}

export function applySuccessfulInventoryFields(
  current: InventoryItem,
  succeededFields: ReadonlySet<InventorySaveField>,
  fieldPatches: Partial<Record<InventorySaveField, Partial<InventoryItem>>>,
): InventoryItem {
  let updated = current;
  for (const field of succeededFields) {
    const patch = fieldPatches[field];
    if (patch) updated = { ...updated, ...patch };
  }
  return updated;
}

/**
 * Runs one inventory write with a deadline and a caller-owned AbortController.
 * The controller set is shared by an editor so unmount can cancel every write
 * that is still pending.
 */
export async function runInventoryWrite<T>(
  controllers: Set<AbortController>,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  controllers.add(controller);
  const timeoutError = new InventoryWriteTimeoutError(INVENTORY_WRITE_TIMEOUT_MS);
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutError);
    rejectTimeout?.(timeoutError);
  }, INVENTORY_WRITE_TIMEOUT_MS);

  try {
    const requestPromise = Promise.resolve().then(() => request(controller.signal));
    // A transport should reject when aborted, but keeping this handler also
    // prevents a late rejection from an uncooperative implementation becoming
    // an unhandled promise after the deadline has already won the race.
    void requestPromise.catch(() => undefined);
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    // Some React Native fetch implementations reject with a generic
    // AbortError instead of propagating AbortSignal.reason.
    if (controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.name === "TimeoutError") {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    controllers.delete(controller);
  }
}