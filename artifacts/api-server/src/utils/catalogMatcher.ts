/**
 * Catalog number matcher.
 * Matches extracted catalog entries against existing inventory rows for a
 * given vendor, using exact match first then pg_trgm similarity fallback.
 *
 * Returns null when no match is found above the confidence threshold.
 */

import { db } from "@workspace/db";
import { inventoryTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";

export interface MatchResult {
  inventoryId: number;
  similarityScore: number;
}

const EXACT_SCORE = 1.0;
const TRGM_THRESHOLD = 0.4;

/**
 * Try to find a matching inventory row for the given vendor + catalog number.
 * Strategy:
 *   1. Exact case-insensitive match
 *   2. pg_trgm similarity match (score >= TRGM_THRESHOLD)
 */
export async function matchCatalogNumber(
  vendor: string,
  catalogNumber: string,
): Promise<MatchResult | null> {
  const vendorUpper = vendor.toUpperCase();

  // 1. Exact match (normalise whitespace)
  const normalised = catalogNumber.replace(/\s+/g, "").toUpperCase();
  const exactRows = await db
    .select({ id: inventoryTable.id })
    .from(inventoryTable)
    .where(
      and(
        eq(inventoryTable.vendor, vendorUpper),
        sql`upper(replace(${inventoryTable.catalog}, ' ', '')) = ${normalised}`,
      ),
    )
    .limit(1);

  if (exactRows.length > 0 && exactRows[0]) {
    return { inventoryId: exactRows[0].id, similarityScore: EXACT_SCORE };
  }

  // 2. Trigram similarity fallback
  const trgmRows = await db
    .select({
      id: inventoryTable.id,
      sim: sql<number>`similarity(${inventoryTable.catalog}, ${catalogNumber})`,
    })
    .from(inventoryTable)
    .where(
      and(
        eq(inventoryTable.vendor, vendorUpper),
        sql`similarity(${inventoryTable.catalog}, ${catalogNumber}) >= ${TRGM_THRESHOLD}`,
      ),
    )
    .orderBy(sql`similarity(${inventoryTable.catalog}, ${catalogNumber}) DESC`)
    .limit(1);

  if (trgmRows.length > 0 && trgmRows[0]) {
    return { inventoryId: trgmRows[0].id, similarityScore: trgmRows[0].sim };
  }

  return null;
}
