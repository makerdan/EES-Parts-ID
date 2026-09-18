import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const inventorySnapshotAuditTable = pgTable("inventory_snapshot_audit", {
  id: serial("id").primaryKey(),
  adminClerkUserId: text("admin_clerk_user_id").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  action: text("action").notNull().$type<"dry-run" | "restore" | "approve-empty-baseline">(),
  rowCount: integer("row_count"),
  outcome: text("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});