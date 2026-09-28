import type { InventoryItem } from "@workspace/api-client-react";
import { getListInventoryQueryKey } from "@workspace/api-client-react";

import { DIMENSION_INPUT_ERROR, parseDimensionText } from "@/utils/dimensionValidation";
import {
  type AsyncStorageLike,
  invalidateAllCachesAfterSave,
  type QueryClientLikeWithSetQueries,
} from "@/utils/editItemCache";
import {
  inventorySaveErrorMessage,
  type InventorySaveField,
} from "@/utils/inventoryWrite";

type SharedPartDimensions = {
  length: number | null;
  width: number | null;
  height: number | null;
  diameter: number | null;
};

type SharedPartPhotoDraft =
  | { kind: "upload"; source: string }
  | { kind: "remove" };

export type SharedPartSaveDraft = {
  description: string;
  bins: ReadonlyArray<string>;
  pendingBin?: string;
  barcodes?: ReadonlyArray<string>;
  pendingBarcode?: string;
  keywords: ReadonlyArray<string>;
  pendingKeyword?: string;
  op: string | number;
  oq: string | number;
  dimensions: {
    length: string | number | null | undefined;
    width: string | number | null | undefined;
    height: string | number | null | undefined;
    diameter: string | number | null | undefined;
  };
  photo?: SharedPartPhotoDraft;
  photo2?: SharedPartPhotoDraft;
};

export type SharedPartSaveCapabilities = {
  barcodes?: boolean;
  photo?: boolean;
  photo2?: boolean;
};

export type SharedPartSaveWriters = {
  description?: (value: string) => Promise<unknown>;
  bins?: (value: ReadonlyArray<string>) => Promise<unknown>;
  barcodes?: (value: ReadonlyArray<string>) => Promise<unknown>;
  keywords?: (value: ReadonlyArray<string>) => Promise<unknown>;
  opoq?: (value: { orderPurchase: number; orderQuantity: number }) => Promise<unknown>;
  dimensions?: (value: SharedPartDimensions) => Promise<unknown>;
  photo?: (value: SharedPartPhotoDraft) => Promise<unknown>;
  photo2?: (value: SharedPartPhotoDraft) => Promise<unknown>;
};

export type SharedPartSaveCacheContext = {
  queryClient: QueryClientLikeWithSetQueries & {
    getQueriesData<T>(
      filter: { predicate: (q: { queryKey: unknown }) => boolean },
    ): Array<[unknown, T | undefined]>;
    setQueryData(key: unknown, value: unknown): void;
  };
  asyncStorage: AsyncStorageLike;
};

export type SharedPartSaveNormalized = {
  description: string;
  bins: Array<string>;
  barcodes?: Array<string>;
  keywords: Array<string>;
  orderPurchase: number;
  orderQuantity: number;
  dimensions: SharedPartDimensions;
  photo?: SharedPartPhotoDraft;
  photo2?: SharedPartPhotoDraft;
};

type SharedPartSaveOutcome = {
  status: "fulfilled" | "rejected";
  value?: unknown;
  error?: string;
};

export type SharedPartSaveResult = {
  normalized: SharedPartSaveNormalized;
  operations: Array<InventorySaveField>;
  outcomes: Partial<Record<InventorySaveField, SharedPartSaveOutcome>>;
  succeededFields: Set<InventorySaveField>;
  failedFields: Set<InventorySaveField>;
  fieldErrors: Partial<Record<InventorySaveField, string>>;
  message: string | null;
  anyFailed: boolean;
  committedItem: InventoryItem;
  retryableDrafts: Partial<Record<InventorySaveField, unknown>>;
  cacheReconciled: boolean;
  cacheWarning: boolean;
};

const FIELD_LABELS: Record<InventorySaveField, string> = {
  description: "Description",
  bins: "Bins",
  barcodes: "Barcodes",
  keywords: "Keywords",
  dimensions: "Dimensions",
  opoq: "OP/OQ",
  photo: "Photo 1",
  photo2: "Photo 2",
};

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeArray(
  values: ReadonlyArray<string>,
  options: { lowercase?: boolean; caseInsensitive?: boolean } = {},
): Array<string> {
  const result: Array<string> = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = (options.lowercase ? raw.toLowerCase() : raw).trim();
    if (!value) continue;
    const key = options.caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizeSharedDimension(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = parseDimensionText(String(value));
  if (!parsed.valid) throw new Error(DIMENSION_INPUT_ERROR);
  return parsed.value;
}

export function normalizeSharedPartDraft(draft: SharedPartSaveDraft): {
  normalized: SharedPartSaveNormalized;
  invalidFields: Partial<Record<InventorySaveField, string>>;
} {
  const bins = normalizeArray(
    [...draft.bins, ...(draft.pendingBin?.trim() ? [draft.pendingBin] : [])],
    { caseInsensitive: true },
  );
  const barcodes = draft.barcodes === undefined
    ? undefined
    : normalizeArray([
        ...draft.barcodes,
        ...(draft.pendingBarcode?.trim() ? [draft.pendingBarcode] : []),
      ]);
  const keywords = normalizeArray(
    [...draft.keywords, ...(draft.pendingKeyword?.trim() ? [draft.pendingKeyword] : [])],
    { lowercase: true },
  );
  const orderPurchase = typeof draft.op === "number" ? draft.op : Number(draft.op.trim() || "0");
  const orderQuantity = typeof draft.oq === "number" ? draft.oq : Number(draft.oq.trim() || "0");
  const dimensions: SharedPartDimensions = {
    length: normalizeSharedDimension(draft.dimensions.length),
    width: normalizeSharedDimension(draft.dimensions.width),
    height: normalizeSharedDimension(draft.dimensions.height),
    diameter: normalizeSharedDimension(draft.dimensions.diameter),
  };
  const invalidFields: Partial<Record<InventorySaveField, string>> = {};
  if (![orderPurchase, orderQuantity].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    invalidFields.opoq = "OP and OQ must be non-negative whole numbers.";
  }
  return {
    normalized: {
      description: draft.description.trim(),
      bins,
      ...(barcodes ? { barcodes } : {}),
      keywords,
      orderPurchase,
      orderQuantity,
      dimensions,
      ...(draft.photo ? { photo: draft.photo } : {}),
      ...(draft.photo2 ? { photo2: draft.photo2 } : {}),
    },
    invalidFields,
  };
}

function fieldPatch(
  field: InventorySaveField,
  attempted: Partial<InventoryItem>,
  response: unknown,
): Partial<InventoryItem> {
  if (response && typeof response === "object") {
    const item = response as Partial<InventoryItem> & {
      imageUrl?: string | null;
      imageUrl2?: string | null;
    };
    switch (field) {
      case "description":
        if (typeof item.description === "string") return { description: item.description };
        break;
      case "bins":
        if (Array.isArray(item.binLocations)) return { binLocations: item.binLocations };
        break;
      case "barcodes":
        if (Array.isArray(item.barcodes)) return { barcodes: item.barcodes };
        break;
      case "keywords":
        if (Array.isArray(item.aiKeywords)) return { aiKeywords: item.aiKeywords };
        break;
      case "dimensions":
        if ("dimensions" in item) return { dimensions: item.dimensions };
        break;
      case "opoq":
        if (typeof item.orderPurchase === "number" && typeof item.orderQuantity === "number") {
          return {
            orderPurchase: item.orderPurchase,
            orderQuantity: item.orderQuantity,
            ...(typeof item.totalOpOq === "number" ? { totalOpOq: item.totalOpOq } : {}),
          };
        }
        break;
      case "photo":
        if ("imageUrl" in item) return { imageUrl: item.imageUrl, thumbnailUrl: item.thumbnailUrl ?? null };
        break;
      case "photo2":
        if ("imageUrl2" in item) return { imageUrl2: item.imageUrl2, thumbnailUrl2: item.thumbnailUrl2 ?? null };
        break;
    }
  }
  return attempted;
}

function attemptedPatches(
  normalized: SharedPartSaveNormalized,
): Partial<Record<InventorySaveField, Partial<InventoryItem>>> {
  return {
    description: { description: normalized.description },
    bins: { binLocations: normalized.bins },
    ...(normalized.barcodes ? { barcodes: { barcodes: normalized.barcodes } } : {}),
    keywords: { aiKeywords: normalized.keywords },
    opoq: {
      orderPurchase: normalized.orderPurchase,
      orderQuantity: normalized.orderQuantity,
      totalOpOq: normalized.orderPurchase + normalized.orderQuantity,
    },
    dimensions: { dimensions: normalized.dimensions },
    ...(normalized.photo?.kind === "remove" ? { photo: { imageUrl: null, thumbnailUrl: null } } : {}),
    ...(normalized.photo2?.kind === "remove" ? { photo2: { imageUrl2: null, thumbnailUrl2: null } } : {}),
  };
}

function createMessage(
  succeeded: ReadonlySet<InventorySaveField>,
  failed: ReadonlySet<InventorySaveField>,
  errors: Partial<Record<InventorySaveField, string>>,
): string | null {
  if (failed.size === 0) return null;
  if ([...Object.values(errors)].some((message) => message?.includes("Session expired"))) {
    return "Admin session expired. Re-unlock and try again.";
  }
  const saved = [...succeeded].map((field) => FIELD_LABELS[field]);
  const rejected = [...failed].map((field) => FIELD_LABELS[field]);
  return `${saved.length ? `${saved.join(", ")} saved · ` : ""}${rejected.join(", ")} failed — check connection and retry`;
}

/**
 * Shared save coordinator for both the routed and inline part editors.
 *
 * UI owners provide the field writers because they own authentication,
 * transport, file reading, and mutation hooks. This function owns all
 * normalization, change detection, settlement pairing, cache rollback, and
 * committed-state calculation.
 */
export async function coordinateSharedPartSave(input: {
  current: InventoryItem;
  draft: SharedPartSaveDraft;
  capabilities?: SharedPartSaveCapabilities;
  writers: SharedPartSaveWriters;
  cache: SharedPartSaveCacheContext;
}): Promise<SharedPartSaveResult> {
  const { current, cache, writers } = input;
  const capabilities = input.capabilities ?? {};
  const { normalized, invalidFields } = normalizeSharedPartDraft(input.draft);
  const attempted = attemptedPatches(normalized);
  const listKeyPrefix = String(getListInventoryQueryKey()[0]);
  // Snapshot before invoking any writer. TanStack mutation writers may apply
  // synchronous optimistic updates before returning their promise.
  const inventorySnapshot = cache.queryClient.getQueriesData<unknown>({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] === listKeyPrefix,
  });
  const searchSnapshot = cache.queryClient.getQueriesData<unknown>({
    predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] === "searchInventory",
  });
  const operations: Array<{
    field: InventorySaveField;
    promise: Promise<unknown>;
    patch: Partial<InventoryItem>;
    retryableDraft: unknown;
  }> = [];

  const add = (
    field: InventorySaveField,
    writer: (() => Promise<unknown>) | undefined,
    patch: Partial<InventoryItem>,
    retryableDraft: unknown,
  ) => {
    if (!writer) return;
    let promise: Promise<unknown>;
    try {
      promise = writer();
    } catch (error) {
      promise = Promise.reject(error);
    }
    operations.push({
      field,
      promise,
      patch,
      retryableDraft,
    });
  };

  if (!invalidFields.opoq && normalized.description !== (current.description ?? "").trim()) {
    add("description", writers.description?.bind(null, normalized.description), attempted.description!, normalized.description);
  }
  if (!equalJson(normalized.bins, current.binLocations ?? [])) {
    add("bins", writers.bins?.bind(null, normalized.bins), attempted.bins!, normalized.bins);
  }
  if (capabilities.barcodes !== false && normalized.barcodes &&
      !equalJson(normalized.barcodes, current.barcodes ?? [])) {
    add("barcodes", writers.barcodes?.bind(null, normalized.barcodes), attempted.barcodes!, normalized.barcodes);
  }
  if (!equalJson(normalized.keywords, current.aiKeywords ?? [])) {
    add("keywords", writers.keywords?.bind(null, normalized.keywords), attempted.keywords!, normalized.keywords);
  }
  if (!invalidFields.opoq &&
      (normalized.orderPurchase !== current.orderPurchase || normalized.orderQuantity !== current.orderQuantity)) {
    add(
      "opoq",
      writers.opoq?.bind(null, {
        orderPurchase: normalized.orderPurchase,
        orderQuantity: normalized.orderQuantity,
      }),
      attempted.opoq!,
      {
        orderPurchase: normalized.orderPurchase,
        orderQuantity: normalized.orderQuantity,
      },
    );
  }
  const currentDimensions = current.dimensions ?? {};
  if (!equalJson(normalized.dimensions, {
    length: currentDimensions.length ?? null,
    width: currentDimensions.width ?? null,
    height: currentDimensions.height ?? null,
    diameter: currentDimensions.diameter ?? null,
  })) {
    add("dimensions", writers.dimensions?.bind(null, normalized.dimensions), attempted.dimensions!, normalized.dimensions);
  }
  if (capabilities.photo !== false && normalized.photo &&
      writers.photo && ((normalized.photo.kind === "remove" && current.imageUrl) || normalized.photo.kind === "upload")) {
    add("photo", () => writers.photo!(normalized.photo!), attempted.photo ?? {}, normalized.photo);
  }
  if (capabilities.photo2 !== false && normalized.photo2 &&
      writers.photo2 && ((normalized.photo2.kind === "remove" && current.imageUrl2) || normalized.photo2.kind === "upload")) {
    add("photo2", () => writers.photo2!(normalized.photo2!), attempted.photo2 ?? {}, normalized.photo2);
  }

  const baseResult = {
    normalized,
    operations: operations.map((operation) => operation.field),
    outcomes: {} as Partial<Record<InventorySaveField, SharedPartSaveOutcome>>,
    succeededFields: new Set<InventorySaveField>(),
    failedFields: new Set<InventorySaveField>(),
    fieldErrors: { ...invalidFields },
    message: null as string | null,
    anyFailed: Object.keys(invalidFields).length > 0,
    committedItem: current,
    retryableDrafts: {} as Partial<Record<InventorySaveField, unknown>>,
    cacheReconciled: false,
    cacheWarning: false,
  };

  if (Object.keys(invalidFields).length > 0) {
    baseResult.message = invalidFields.opoq ?? "Some fields are invalid.";
    baseResult.failedFields.add("opoq");
    baseResult.retryableDrafts.opoq = {
      orderPurchase: input.draft.op,
      orderQuantity: input.draft.oq,
    };
    return baseResult;
  }

  if (operations.length === 0) {
    return baseResult;
  }

  const settled = await Promise.allSettled(operations.map((operation) => operation.promise));
  const patches: Partial<Record<InventorySaveField, Partial<InventoryItem>>> = {};
  for (const [index, result] of settled.entries()) {
    const operation = operations[index];
    if (!operation) continue;
    if (result.status === "fulfilled") {
      baseResult.succeededFields.add(operation.field);
      patches[operation.field] = fieldPatch(operation.field, operation.patch, result.value);
      baseResult.outcomes[operation.field] = { status: "fulfilled", value: result.value };
    } else {
      baseResult.failedFields.add(operation.field);
      const error = inventorySaveErrorMessage(result.reason);
      baseResult.fieldErrors[operation.field] = error;
      baseResult.retryableDrafts[operation.field] = operation.retryableDraft;
      baseResult.outcomes[operation.field] = { status: "rejected", error };
    }
  }
  baseResult.anyFailed = baseResult.failedFields.size > 0;
  baseResult.message = createMessage(
    baseResult.succeededFields,
    baseResult.failedFields,
    baseResult.fieldErrors,
  );

  const successfulItem = () => {
    let item = current;
    for (const field of baseResult.succeededFields) {
      const patch = patches[field];
      if (patch) item = { ...item, ...patch };
    }
    // Real inventory responses always carry dimensions. Preserve the
    // established editor contract for older/partial test and offline
    // snapshots by materializing the normalized dimensions only when the
    // selected item has no dimensions property at all.
    if (baseResult.succeededFields.size > 0 && !("dimensions" in item)) {
      item = { ...item, dimensions: normalized.dimensions };
    }
    return item;
  };
  baseResult.committedItem = successfulItem();

  if (baseResult.anyFailed) {
    for (const [key, value] of inventorySnapshot) cache.queryClient.setQueryData(key, value);
    for (const [key, value] of searchSnapshot) cache.queryClient.setQueryData(key, value);
  }

  if (baseResult.succeededFields.size > 0) {
    const cacheResult = await invalidateAllCachesAfterSave({
      queryClient: cache.queryClient,
      asyncStorage: cache.asyncStorage,
      itemId: current.id,
      updatedItem: baseResult.committedItem,
    });
    baseResult.cacheReconciled = true;
    baseResult.cacheWarning = !cacheResult.ok;
  } else if (baseResult.anyFailed) {
    const cacheResult = await invalidateAllCachesAfterSave({
      queryClient: cache.queryClient,
      asyncStorage: cache.asyncStorage,
      itemId: current.id,
    });
    baseResult.cacheWarning = Boolean(cacheResult && !cacheResult.ok);
  }

  return baseResult;
}