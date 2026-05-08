/**
 * `dictionary_version` — single-row counter table.
 *
 * A PostgreSQL trigger on each dictionary table (synonym_group,
 * abbreviation_map, electrical_slang_map, misspelling_map) increments
 * this counter after any INSERT, UPDATE, or DELETE statement.
 *
 * The inventory table's `tokens_dict_version` column records which version
 * each row's `search_tokens` was built against. The rebuild-tokens job
 * selects only rows where `tokens_dict_version < current version`, avoiding
 * a full table scan when only a handful of dictionary entries changed.
 */
import { pgTable, integer, timestamp } from 'drizzle-orm/pg-core';

export const dictionaryVersionTable = pgTable('dictionary_version', {
  id: integer('id').primaryKey().default(1),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type DictionaryVersion = typeof dictionaryVersionTable.$inferSelect;
