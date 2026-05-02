/**
 * Postgres connection pool + Drizzle binding shared by every server-side
 * package. We expose both `pool` (for graceful shutdown in `index.ts`
 * of api-server) and `db` (the Drizzle query builder used by routes
 * and seeds).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep TCP connections alive so Replit's PostgreSQL doesn't silently
  // close idle connections and leave the pool serving dead sockets.
  keepAlive: true,
  // Fail fast if a new connection can't be established within 5s.
  connectionTimeoutMillis: 5_000,
  // Release idle connections after 30s to avoid accumulating stale sockets.
  idleTimeoutMillis: 30_000,
  // Cap pool size — 10 concurrent DB connections is ample for this app.
  max: 10,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
