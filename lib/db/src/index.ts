import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Keep the application pool at pg's intended default outside Jest. Test
// workers share the development database with the running API service, so
// each worker gets a deliberately small pool that still supports concurrent
// requests within a test.
export const DEFAULT_POOL_MAX = 10;
export const JEST_POOL_MAX = 2;

export function getPoolMax(isJest = Boolean(process.env.JEST_WORKER_ID)): number {
  return isJest ? JEST_POOL_MAX : DEFAULT_POOL_MAX;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: getPoolMax(),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  // Under Jest (JEST_WORKER_ID is set), let the worker process exit when the
  // pool's clients are idle instead of requiring an explicit pool.end().
  // Closing the pool from a setupFilesAfterEnv afterAll is unsafe: those hooks
  // run BEFORE the test file's own afterAll, so per-suite DB cleanup would hit
  // an already-ended pool. allowExitOnIdle removes the need for global
  // teardown entirely. Production/dev behaviour is unchanged.
  allowExitOnIdle: Boolean(process.env.JEST_WORKER_ID),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./taxonomy";
