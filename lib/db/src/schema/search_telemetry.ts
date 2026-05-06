/**
 * Search telemetry tables — one row per search event, one per result click.
 *
 * Populated non-blocking (fire-and-forget) by the inventory search route so
 * telemetry failures never affect search response latency or correctness.
 * Used by Stage 2+ ranking changes to evaluate quality against real queries.
 *
 * Design notes:
 *   - No user_id / session_id — workers are anonymous (no auth system).
 *   - result_id references inventory.id (serial integer, not uuid).
 *   - query_source 'chip' covers searches driven entirely by chip filters
 *     with no free-text keywords.
 *   - filters_json stored as jsonb (in DB); represented as text here for schema
 *     portability — the route serializes with JSON.stringify and casts ::jsonb.
 *   - layers_hit records which pipeline layers contributed to results:
 *     'fts', 'trigram', 'exact_catalog', 'fuse_fallback', 'vendor_boost'.
 */
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const searchEventTable = pgTable(
  "search_event",
  {
    id:              serial("id").primaryKey(),
    ts:              timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    queryRaw:        text("query_raw").notNull(),
    queryNormalized: text("query_normalized").notNull(),
    querySource:     text("query_source").notNull(),
    filtersJson:     text("filters_json").notNull().default("{}"),
    resultsCount:    integer("results_count").notNull(),
    topResultId:     integer("top_result_id"),
    latencyMs:       integer("latency_ms").notNull(),
    layersHit:       text("layers_hit").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    index("idx_search_event_ts").on(table.ts),
    index("idx_search_event_query").on(table.queryNormalized),
  ],
);

export const searchEventClickTable = pgTable(
  "search_event_click",
  {
    id:            serial("id").primaryKey(),
    searchEventId: integer("search_event_id").notNull(),
    ts:            timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    resultId:      integer("result_id").notNull(),
    resultRank:    integer("result_rank").notNull(),
    action:        text("action").notNull(),
  },
  (table) => [
    index("idx_search_event_click_event").on(table.searchEventId),
    index("idx_search_event_click_result").on(table.resultId, table.ts),
  ],
);

export type SearchEvent = typeof searchEventTable.$inferSelect;
export type SearchEventClick = typeof searchEventClickTable.$inferSelect;
