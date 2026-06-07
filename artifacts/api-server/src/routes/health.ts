import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

const DB_LATENCY_DEGRADED_MS = Number(
  process.env.DB_LATENCY_DEGRADED_MS ?? 500,
);

router.get("/healthz", async (_req, res) => {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    const db_latency_ms = Date.now() - start;

    const pool_idle = pool.idleCount;
    const pool_total = pool.totalCount;

    const status = db_latency_ms >= DB_LATENCY_DEGRADED_MS ? "degraded" : "ok";

    const data = HealthCheckResponse.parse({
      status,
      db_latency_ms,
      pool_idle,
      pool_total,
    });
    res.json(data);
  } catch {
    res.status(503).json({ status: "error", detail: "database unreachable" });
  }
});

export default router;
