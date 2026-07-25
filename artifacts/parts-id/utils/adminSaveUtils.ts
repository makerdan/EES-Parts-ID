/**
 * Pure utility functions extracted from the admin handleSave path.
 *
 * All functions here are dependency-free (no React, no network, no storage) so
 * they can be imported in any Jest/Node environment and tested in isolation.
 */

export type PartDimensions = {
  length: number | null;
  width: number | null;
  height: number | null;
  diameter: number | null;
};

export function parseDimField(s: string): number | null {
  const n = parseFloat(s);
  return isNaN(n) || n < 0 ? null : Math.round(n * 10) / 10;
}

/**
 * Merge a pending bin text entry into an existing bins array.
 * If the pending text (trimmed) already exists case-insensitively, it is NOT
 * added again. Returns the same array reference when nothing changes.
 */
export function buildFinalBins(bins: Array<string>, newBin: string): Array<string> {
  const pending = newBin.trim();
  if (pending && !bins.some((b) => b.toLowerCase() === pending.toLowerCase())) {
    return [...bins, pending];
  }
  return bins;
}

/**
 * Merge a pending keyword entry into an existing keywords array.
 * Keywords are lowercased before comparison; duplicates are silently dropped.
 * Returns the same array reference when nothing changes.
 */
export function buildFinalKeywords(keywords: Array<string>, newKeyword: string): Array<string> {
  const pending = newKeyword.trim().toLowerCase();
  if (pending && !keywords.includes(pending)) {
    return [...keywords, pending];
  }
  return keywords;
}

export function buildNewDims(
  dimLength: string,
  dimWidth: string,
  dimHeight: string,
  dimDiameter: string,
): PartDimensions {
  return {
    length: parseDimField(dimLength),
    width: parseDimField(dimWidth),
    height: parseDimField(dimHeight),
    diameter: parseDimField(dimDiameter),
  };
}

export function checkDimsChanged(
  newDims: PartDimensions,
  existingDims: Partial<PartDimensions> | null | undefined,
): boolean {
  const old = existingDims ?? {};
  return (
    newDims.length !== (old.length ?? null) ||
    newDims.width !== (old.width ?? null) ||
    newDims.height !== (old.height ?? null) ||
    newDims.diameter !== (old.diameter ?? null)
  );
}

export interface CachePatchOptions {
  targetId: number;
  description: string;
  binLocations: Array<string>;
  aiKeywords: Array<string>;
  dimsChanged: boolean;
  newDims: PartDimensions;
  capturedImageUrl?: string | null;
  capturedImageUrl2?: string | null;
}

/**
 * Build a patched version of a single inventory item for synchronous cache
 * updates after a successful save. Returns the item unchanged when its id does
 * not match `targetId`.
 *
 * Only spreads `dimensions` when `dimsChanged` is true so that an unchanged
 * (potentially null) dimensions field from the original item is preserved.
 */
export function buildPatchedItem<
  T extends {
    id: number;
    description: string | null;
    binLocations: Array<string>;
    aiKeywords: Array<string>;
    dimensions?: PartDimensions | null;
    imageUrl?: string | null;
    imageUrl2?: string | null;
  },
>(item: T, opts: CachePatchOptions): T {
  if (item.id !== opts.targetId) return item;
  return {
    ...item,
    description: opts.description,
    binLocations: opts.binLocations,
    aiKeywords: opts.aiKeywords,
    ...(opts.dimsChanged ? { dimensions: opts.newDims } : {}),
    ...(opts.capturedImageUrl !== undefined ? { imageUrl: opts.capturedImageUrl } : {}),
    ...(opts.capturedImageUrl2 !== undefined ? { imageUrl2: opts.capturedImageUrl2 } : {}),
  };
}

export type SaveOpField =
  | "description"
  | "bins"
  | "keywords"
  | "dimensions"
  | "photo"
  | "photo2";

export type SaveOp = {
  field: SaveOpField;
  promise: Promise<unknown>;
  restoreFn: () => void;
};

export type ExecuteSaveOpsResult = {
  anyFailed: boolean;
  fieldErrors: Partial<Record<SaveOpField, string>>;
};

/**
 * Execute a list of save operations concurrently, calling each op's restoreFn
 * when it rejects.
 *
 * Returns `{ anyFailed, fieldErrors }` so callers can apply cache rollbacks and
 * display per-field error messages without knowing about the individual ops.
 */
export async function executeSaveOps(ops: Array<SaveOp>): Promise<ExecuteSaveOpsResult> {
  const results = await Promise.allSettled(ops.map((o) => o.promise));
  const fieldErrors: Partial<Record<SaveOpField, string>> = {};
  let anyFailed = false;

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      anyFailed = true;
      // i indexes into ops since results is a 1:1 map over ops
      const op = ops[i]!;
      op.restoreFn();
      const msg =
        result.reason instanceof Error ? result.reason.message : "Save failed";
      fieldErrors[op.field] = msg.includes("401")
        ? "Session expired — re-unlock admin access"
        : "Could not save — check connection";
    }
  });

  return { anyFailed, fieldErrors };
}
