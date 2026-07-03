import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type UserStatus = "pending" | "approved" | "banned";

/**
 * Admin role, independent of the pending/approved/banned status.
 * "admin" grants access to admin-only API endpoints; "user" is the default.
 */
export type UserRole = "user" | "admin";

export const usersTable = pgTable("users", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  email: text("email").notNull().default(""),
  status: text("status").notNull().default("pending").$type<UserStatus>(),
  role: text("role").notNull().default("user").$type<UserRole>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
