import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export type AdminAuditAction = "approve" | "ban" | "promote" | "demote";

export const adminAuditLogTable = pgTable("admin_audit_log", {
  id: serial("id").primaryKey(),
  adminClerkUserId: text("admin_clerk_user_id").notNull(),
  targetClerkUserId: text("target_clerk_user_id").notNull(),
  action: text("action").notNull().$type<AdminAuditAction>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type AdminAuditLog = typeof adminAuditLogTable.$inferSelect;
export type InsertAdminAuditLog = typeof adminAuditLogTable.$inferInsert;
