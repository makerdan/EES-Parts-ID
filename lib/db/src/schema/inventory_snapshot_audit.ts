import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const inventorySnapshotAuditTable = pgTable("inventory_snapshot_audit", {
  id: serial("id").primaryKey(),
  adminClerkUserId: text("admin_clerk_user_id").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  action: text("action").notNull().$type<"dry-run" | "restore" | "approve-empty-baseline" | "manual-backup">(),
  rowCount: integer("row_count"),
  outcome: text("outcome").notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});