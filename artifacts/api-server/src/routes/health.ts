import { HealthCheckResponse } from "@workspace/api-zod";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { type IRouter,Router } from "express";

import { getProbeSummary } from "../lib/aiProvider";
import {
  appReadiness,
  checkRequiredSchema,
  type SchemaProbeClient,
} from "../lib/readiness";

const router: IRouter = Router();

const DB_LATENCY_DEGRADED_MS = Number(
  process.env.DB_LATENCY_DEGRADED_MS ?? 500,
);
const HEALTH_SCHEMA_PROBE_TIMEOUT_MS = 4_000;

type SchemaProbePool = {
  connect: () => Promise<SchemaProbeClient>;
};

type HealthSchemaProbeOptions = {
  timeoutMs?: number;
  probe?: (client: SchemaProbeClient) => Promise<boolean>;
};

/**
 * Run the request-time schema check with an owned client and a hard deadline.
 *
 * A Promise.race alone would only bound the HTTP response; it would leave a
 * late PostgreSQL query holding a pooled client. Passing the timeout error to
 * release destroys that client instead of returning it while it may still be
 * busy. A client that connects after the deadline is destroyed as well.
 */
export async function runHealthSchemaProbe(
  schemaPool: SchemaProbePool,
  options: HealthSchemaProbeOptions = {},
): Promise<boolean> {
  const timeoutMs = Math.max(
    1,
    Math.ceil(options.timeoutMs ?? HEALTH_SCHEMA_PROBE_TIMEOUT_MS),
  );
  const timeoutError = new Error("Health schema probe timed out");
  let timedOut = false;
  let client: SchemaProbeClient | undefined;
  let timer: NodeJS.Timeout | undefined;

  const connectPromise = schemaPool.connect();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });

  try {
    client = await Promise.race([connectPromise, deadline]);
    const probe =
      options.probe ??
      ((probeClient: SchemaProbeClient) =>
        checkRequiredSchema(probeClient, { statementTimeoutMs: timeoutMs }));
    return await Promise.race([probe(client), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (client !== undefined) {
      client.release(timedOut ? timeoutError : undefined);
    } else {
      void connectPromise.then(
        (lateClient) => lateClient.release(timeoutError),
        () => undefined,
      );
    }
  }
}

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
    const schemaUsable = await runHealthSchemaProbe(pool);
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
