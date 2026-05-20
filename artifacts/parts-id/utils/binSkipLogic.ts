/**
 * Pure utility functions for the bin-replacement skip toggle feature.
 * Extracted from upload.tsx so they can be unit-tested without rendering
 * the full screen component.
 */

export type ParsedRow = {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
  barcodes: string[];
};

export type BinDiffRow = {
  vendor: string;
  catalog: string;
  status: "replace" | "add" | "preserve" | "none";
  existingBins: string[];
  incomingBins: string[];
  barcodeStatus?: "replace" | "add" | "preserve" | "none" | "conflict";
  existingBarcodes?: string[];
  /** Set when barcodeStatus === "conflict": the item that already owns one of the incoming barcodes. */
  conflictingItem?: { vendor: string; catalog: string };
};

/**
 * Toggle a single row index in/out of the skip set.
 * Returns a new Set — never mutates the original.
 */
export function toggleSkipRow(prev: Set<number>, idx: number): Set<number> {
  const next = new Set(prev);
  if (next.has(idx)) {
    next.delete(idx);
  } else {
    next.add(idx);
  }
  return next;
}

/**
 * Collect every index in rows whose status is "replace".
 */
export function getReplaceIndices(rows: BinDiffRow[]): number[] {
  return rows.map((r, i) => (r.status === "replace" ? i : -1)).filter(i => i >= 0);
}

/**
 * Skip-all / restore-all toggle:
 * - If every replace index is already skipped → restore-all (return empty Set).
 * - Otherwise → skip-all (return Set of all replace indices).
 * Mirrors the Pressable onPress handler in upload.tsx.
 */
export function toggleSkipAll(rows: BinDiffRow[], current: Set<number>): Set<number> {
  const replaceIndices = getReplaceIndices(rows);
  const allSkipped = replaceIndices.length > 0 && replaceIndices.every(i => current.has(i));
  return allSkipped ? new Set() : new Set(replaceIndices);
}

/**
 * Number of replacements that will actually be applied (not skipped).
 * Shown in the "will replace bins" summary chip.
 */
export function activeReplacementCount(
  willReplaceBins: number,
  skipBinRows: Set<number>,
  rows: BinDiffRow[],
): number {
  return willReplaceBins - [...skipBinRows].filter(idx => rows[idx]?.status === "replace").length;
}

/**
 * Number of bins that will be preserved.
 * Shown in the "bins preserved" summary chip.
 * Equals the base preserved count PLUS any replace rows the user chose to skip.
 */
export function preservedBinCount(
  willPreserveBins: number,
  skipBinRows: Set<number>,
  rows: BinDiffRow[],
): number {
  return willPreserveBins + [...skipBinRows].filter(idx => rows[idx]?.status === "replace").length;
}

/**
 * Serialize parsed rows back to CSV, blanking the bin cell for any row
 * whose index is in skipBinRows (so the server keeps the existing assignment).
 */
export function serializeToCsv(rows: ParsedRow[], skipBinRows: Set<number>): string {
  const header = "Vendor,Catalog,Description,BinLocation,Barcodes";
  const escapeField = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((row, i) => {
    const bin = skipBinRows.has(i) ? "" : row.binLocations.join(";");
    const barcodes = row.barcodes.join(",");
    return [row.vendor, row.catalog, row.description, bin, barcodes]
      .map(escapeField)
      .join(",");
  });
  return [header, ...lines].join("\n");
}
