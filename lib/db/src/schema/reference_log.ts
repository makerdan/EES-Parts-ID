import { sql } from "drizzle-orm";
import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const referenceLogTable = pgTable(
  "reference_log",
  {
    id: serial("id").primaryKey(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    matchedItemCount: integer("matched_item_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // The ask-log route deliberately preserves substring matching. These GIN
    // trigram indexes let PostgreSQL use Bitmap Index Scans for the bounded
    // ILIKE predicates instead of scanning retained history row by row.
    index("reference_log_question_trgm_idx").using(
      "gin",
      sql`${table.question} gin_trgm_ops`,
    ),
    index("reference_log_answer_trgm_idx").using(
      "gin",
      sql`${table.answer} gin_trgm_ops`,
    ),
  ],
);

export type ReferenceLog = typeof referenceLogTable.$inferSelect;
