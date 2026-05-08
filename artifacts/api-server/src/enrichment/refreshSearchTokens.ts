/**
 * Application-layer hook that keeps `inventory.search_tokens` (and the
 * derived trade-size keyword tokens in `ai_keywords`) fresh after every
 * write to the inventory table.
 *
 * Why an app-layer hook instead of a Postgres trigger?
 *   buildSearchTokens() needs the full dictionary tables (synonyms,
 *   abbreviations, slang, misspellings) which live in TypeScript, not
 *   PL/pgSQL. Doing the expansion here keeps a single source of truth
 *   for token logic that's already shared with the enrichment pipeline.
 *
 * Callers (CSV import, admin upload, /upsert-batch, PATCH /:id, the
 * import-spreadsheet seed script) pass the row IDs they just touched.
 * The helper:
 *   1. Loads the four dictionary tables and the current dict_version once.
 *   2. Reloads the affected rows so it operates on the latest stored
 *      vendor / catalog / description / aiKeywords.
 *   3. Merges any conduit/pipe trade-size keyword variants into aiKeywords
 *      (additive, case-insensitive de-dupe) so the Trade Size filter chip
 *      and free-text size search work without waiting for AI enrichment.
 *   4. Rebuilds search_tokens via buildSearchTokens() and stamps the
 *      tokens_dict_version column to the current value so the
 *      rebuild-tokens backstop doesn't redundantly re-process the row.
 *
 * The update intentionally does NOT touch updated_at — the calling write
 * path is responsible for that, and we don't want this maintenance pass to
 * make rows look like they need re-enrichment.
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '@workspace/db';
import {
  inventoryTable,
  synonymGroupTable,
  abbreviationMapTable,
  electricalSlangMapTable,
  misspellingMapTable,
  dictionaryVersionTable,
} from '@workspace/db';
import { buildSearchTokens } from './buildSearchTokens';
import { deriveTradeSizeTokens } from '../utils/tradeSize';

const REFRESH_BATCH_SIZE = 500;

/**
 * Recompute search_tokens (and merge derived trade-size tokens into
 * aiKeywords) for the given inventory row IDs. Safe to call with an
 * empty array.
 */
export async function refreshSearchTokensForIds(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;

  // De-dupe up front so a caller passing the same id twice (e.g. an upsert
  // batch with duplicate keys) doesn't cause two updates per row.
  const uniqueIds = Array.from(new Set(ids));

  const [synonymGroups, abbreviationMaps, slangMaps, misspellingMaps, versionRows] =
    await Promise.all([
      db
        .select({ canonical: synonymGroupTable.canonical, synonyms: synonymGroupTable.synonyms })
        .from(synonymGroupTable),
      db
        .select({
          abbreviation: abbreviationMapTable.abbreviation,
          expansions: abbreviationMapTable.expansions,
        })
        .from(abbreviationMapTable),
      db
        .select({
          slangTerm: electricalSlangMapTable.slangTerm,
          standardTerms: electricalSlangMapTable.standardTerms,
        })
        .from(electricalSlangMapTable),
      db
        .select({
          misspelling: misspellingMapTable.misspelling,
          correction: misspellingMapTable.correction,
        })
        .from(misspellingMapTable),
      db
        .select({ version: dictionaryVersionTable.version })
        .from(dictionaryVersionTable)
        .where(eq(dictionaryVersionTable.id, 1)),
    ]);

  const dictVersion = versionRows[0]?.version ?? 0;

  for (let i = 0; i < uniqueIds.length; i += REFRESH_BATCH_SIZE) {
    const chunk = uniqueIds.slice(i, i + REFRESH_BATCH_SIZE);

    const items = await db
      .select({
        id: inventoryTable.id,
        vendor: inventoryTable.vendor,
        catalog: inventoryTable.catalog,
        description: inventoryTable.description,
        aiKeywords: inventoryTable.aiKeywords,
      })
      .from(inventoryTable)
      .where(inArray(inventoryTable.id, chunk));

    for (const item of items) {
      const existingKeywords = item.aiKeywords ?? [];
      const tradeTokens = deriveTradeSizeTokens(item);
      const existingLower = new Set(existingKeywords.map((k) => k.toLowerCase()));
      const mergedKeywords = [
        ...existingKeywords,
        ...tradeTokens.filter((t) => !existingLower.has(t.toLowerCase())),
      ];

      const searchTokens = buildSearchTokens(
        {
          catalog: item.catalog,
          description: item.description ?? '',
          vendor: item.vendor,
          aiKeywords: mergedKeywords,
        },
        synonymGroups,
        { abbreviationMaps, slangMaps, misspellingMaps }
      );

      await db
        .update(inventoryTable)
        .set({
          aiKeywords: mergedKeywords,
          searchTokens,
          tokensDictVersion: dictVersion,
        })
        .where(eq(inventoryTable.id, item.id));
    }
  }
}
