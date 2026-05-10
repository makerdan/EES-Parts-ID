/**
 * Pure, side-effect-free per-item trade-size derivation used by the backfill
 * script (`src/seed/backfill_attrs.ts`) and tested in isolation.
 *
 * Extracted here so that:
 *   1. The integration test can import and call the *real* derivation function
 *      rather than a hand-rolled copy — ensuring the test validates the
 *      production code path.
 *   2. Future callers (insert hooks, re-parse routes) share one canonical
 *      implementation.
 *
 * No DB or network imports — safe to unit-test without side effects.
 */

import { parseTradeSizeInches, isConduitOrPipe } from '../utils/tradeSize';
import { parseTradeSize } from './parseAttributes';

export interface TradeSizeItem {
  catalog: string | null;
  vendor: string | null;
  description: string | null;
  /** Legacy free-text trade size column (e.g. "3/4", "1-1/2 IN"). */
  tradeSize?: string | null;
  /** Previously computed numeric trade size (idempotency fallback). */
  tradeSizeIn?: string | null;
}

/**
 * Derive the `trade_size_in` value for an inventory row using the same logic
 * as the attribute backfill script.
 *
 * Decision tree (mirrors `backfill_attrs.ts`):
 *   1. Classify the item as conduit/pipe via `isConduitOrPipe` or by the
 *      presence of the legacy `tradeSize` text column.
 *   2. For conduit items, try to extract a size from the catalog code first
 *      (handles vendor-specific encodings like "EMT150" → 1.5").
 *   3. If the catalog parse is out-of-range (>12") or null, fall through to
 *      description → catalog → legacy tradeSize text.
 *   4. Cap the result at 12" to guard against bogus fraction-code matches
 *      on unrelated catalog digit strings (e.g. N3034 → 30.75).
 *   5. Preserve a previously-correct `tradeSizeIn` value when the current
 *      derivation returns null (idempotency).
 *
 * Returns a 3-decimal numeric string (e.g. "0.500") or null.
 */
export function deriveTradeSizeIn(item: TradeSizeItem): string | null {
  const hasTradeSizeText = item.tradeSize != null && item.tradeSize.trim() !== '';
  const isConduit =
    isConduitOrPipe(item.catalog, item.vendor, item.description) || hasTradeSizeText;

  const rawCatalogSize = isConduit ? parseTradeSizeInches(item.catalog) : null;
  const tradeSizeInches = isConduit
    ? rawCatalogSize !== null && rawCatalogSize <= 12
      ? rawCatalogSize
      : (parseTradeSizeInches(item.description) ??
        parseTradeSize(item.description) ??
        parseTradeSize(item.catalog) ??
        parseTradeSize(item.tradeSize))
    : null;

  const computedTradeSizeIn =
    tradeSizeInches !== null && tradeSizeInches <= 12 ? tradeSizeInches.toFixed(3) : null;

  return computedTradeSizeIn ?? item.tradeSizeIn ?? null;
}
