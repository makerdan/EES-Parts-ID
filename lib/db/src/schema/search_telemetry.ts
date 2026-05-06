/**
 * Search telemetry tables — one row per search event, one per result click.
 *
 * Populated non-blocking (fire-and-forget) by the inventory search route so
 * telemetry failures never affect search response latency or correctness.
 * Used by Stage 2+ ranking changes to evaluate quality against real queries.
 *
 * Design notes:
 *   - No user_id / session_id — workers are anonymous (no auth system).
 *   - topResultId / resultId reference inventory.id (serial integer).
 *   - resultId is nullable: the FK is ON DELETE SET NULL so click rows survive
 *     part deletions and remain analyzable in aggregate.
 *   - layers_hit records which pipeline layers contributed to results:
 *     'fts', 'trigram', 'exact_catalog', 'fuse_fallback', 'vendor_boost'.
 *   - filtersJson mirrors the jsonb DB column (chip filter state at query time).
 *   - Both PKs are bigserial in DB; Drizzle uses bigserial column type.
 */
import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const searchEventTable = pgTable(
  "search_event",
  {
    id:              bigserial("id", { mode: "bigint" }).primaryKey(),
    ts:              timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    queryRaw:        text("query_raw").notNull(),
    queryNormalized: text("query_normalized").notNull(),
    querySource:     text("query_source").notNull(),
    filtersJson:     jsonb("filters_json").notNull().default(sql`'{}'::jsonb`),
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
    id:            bigserial("id", { mode: "bigint" }).primaryKey(),
    searchEventId: bigint("search_event_id", { mode: "bigint" }).notNull(),
    ts:            timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    resultId:      integer("result_id"),   // nullable: ON DELETE SET NULL from inventory FK
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
