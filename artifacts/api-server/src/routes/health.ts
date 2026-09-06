import { HealthCheckResponse } from "@workspace/api-zod";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { type IRouter,Router } from "express";

import { getProbeSummary } from "../lib/aiProvider";
import { appReadiness } from "../lib/readiness";

const router: IRouter = Router();

const DB_LATENCY_DEGRADED_MS = Number(
  process.env.DB_LATENCY_DEGRADED_MS ?? 500,
);

router.get("/livez", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/healthz", async (_req, res) => {
  const startup = appReadiness.get();
  if (startup.status !== "ready") {
    res.status(503).json({
      status: "error",
      detail: "startup_not_ready",
      startup_status: startup.status,
    });
    return;
  }

  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    const schemaResult = await db.execute(sql`
      SELECT
        to_regclass('public.inventory') IS NOT NULL
        AND to_regclass('public.users') IS NOT NULL
        AND to_regclass('public.admin_preferences') IS NOT NULL
        AND to_regclass('public.warehouse_zone') IS NOT NULL
        AS usable
    `);
    const schemaUsable = Boolean(
      (schemaResult as unknown as { rows?: Array<{ usable?: boolean }> }).rows?.[0]?.usable,
    );
    if (!schemaUsable) {
      res.status(503).json({ status: "error", detail: "schema_unavailable" });
      return;
    }
    const db_latency_ms = Date.now() - start;

    const pool_idle = pool.idleCount;
    const pool_total = pool.totalCount;

    const status = db_latency_ms >= DB_LATENCY_DEGRADED_MS ? "degraded" : "ok";

    const bots = getProbeSummary();

    const data = HealthCheckResponse.parse({
      status,
      db_latency_ms,
      pool_idle,
      pool_total,
      bots: Object.keys(bots).length > 0 ? bots : undefined,
    });
    res.json(data);
  } catch {
    res.status(503).json({ status: "error", detail: "database_unreachable" });
  }
});

export default router;
