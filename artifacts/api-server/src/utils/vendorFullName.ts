/**
 * Helpers for resolving the canonical "full name" of a vendor on top of
 * inventory rows.
 *
 * The mapping comes from the `vendor_map` table seeded in
 * `src/seed/dictionaries.ts` — each row has a short `code` (e.g. `ETN`)
 * and an array of human names (`["eaton", "cutler hammer", ...]`). The
 * canonical full name surfaced to the mobile app is the first entry of
 * `names`, title-cased.
 *
 * Lookup is intentionally case-insensitive on both sides so that whatever
 * casing inventory rows happen to use for `vendor` still matches the
 * vendor_map `code`.
 */

import { db, vendorMapTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface VendorMapRow {
  code: string;
  names: string[];
}

/**
 * Title-case a single name. Preserves digits and most punctuation; only
 * shifts the first letter of each whitespace- or hyphen-separated word.
 *
 * Examples:
 *   "eaton"            → "Eaton"
 *   "cutler-hammer"    → "Cutler-Hammer"
 *   "general electric" → "General Electric"
 *   "3m"               → "3m"   (first char isn't a letter, left as-is)
 */
export function titleCaseVendorName(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s\-])([a-z])/g, (_, sep, ch: string) => sep + ch.toUpperCase());
}

/**
 * Build a `UPPER(code) → full name` lookup map from a list of vendor_map
 * rows already loaded into memory. Vendors with an empty `names` array
 * are skipped (we have nothing to display).
 */
export function buildVendorFullNameMap(vendors: VendorMapRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of vendors) {
    const first = v.names[0];
    if (!first) continue;
    m.set(v.code.toUpperCase(), titleCaseVendorName(first));
  }
  return m;
}

/**
 * Resolve the full name for a single vendor code (case-insensitive).
 * Returns `null` when no `vendor_map` row matches — callers should
 * surface `null` to clients so they can hide the row.
 */
export async function lookupVendorFullName(vendor: string): Promise<string | null> {
  const code = vendor.trim().toUpperCase();
  if (!code) return null;
  const rows = await db
    .select({ code: vendorMapTable.code, names: vendorMapTable.names })
    .from(vendorMapTable)
    .where(sql`upper(${vendorMapTable.code}) = ${code}`)
    .limit(1);
  return buildVendorFullNameMap(rows).get(code) ?? null;
}

/**
 * Attach `vendorFullName` to an inventory-row-shaped object. The original
 * fields are spread through unchanged; `vendorFullName` is `null` when
 * the lookup misses.
 */
export function withVendorFullName<T extends { vendor: string }>(
  item: T,
  vendorFullNameMap: Map<string, string>,
): T & { vendorFullName: string | null } {
  return {
    ...item,
    vendorFullName: vendorFullNameMap.get(item.vendor.trim().toUpperCase()) ?? null,
  };
}
