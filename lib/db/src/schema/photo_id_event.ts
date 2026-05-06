import { pgTable, bigserial, text, boolean, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const photoIdEventTable = pgTable(
  "photo_id_event",
  {
    id:                 bigserial("id", { mode: "number" }).primaryKey(),
    ts:                 timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    imageHash:          text("image_hash"),
    visionRaw:          jsonb("vision_raw"),
    parseOk:            boolean("parse_ok").notNull().default(false),
    catalogGuess:       text("catalog_guess"),
    vendorGuess:        text("vendor_guess"),
    matchType:          text("match_type"),
    topResultId:        integer("top_result_id"),
    confirmedResultId:  integer("confirmed_result_id"),
    latencyMs:          integer("latency_ms"),
  },
  (t) => [index("idx_photo_id_event_ts").on(t.ts)],
);

export type PhotoIdEvent = typeof photoIdEventTable.$inferSelect;
export type InsertPhotoIdEvent = typeof photoIdEventTable.$inferInsert;
