/**
 * API server entry point. Reads PORT from the environment (assigned per
 * artifact by the Replit proxy), starts the Express app, and wires up a
 * graceful shutdown that drains the Postgres pool before exit so
 * in-flight queries complete cleanly.
 */
import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import {
  refresh as refreshInventoryIndex,
  start as startInventoryIndex,
  stop as stopInventoryIndex,
} from "./lib/inventoryIndex";

// How often to rebuild the in-memory Fuse fuzzy-search index. Defaults
// to 5 minutes; tunable via env so prod can dial it up or down without
// a code change.
const DEFAULT_INVENTORY_INDEX_REFRESH_MS = 5 * 60 * 1000;
const inventoryIndexRefreshMs = (() => {
  const raw = process.env["INVENTORY_INDEX_REFRESH_MS"];
  if (!raw) return DEFAULT_INVENTORY_INDEX_REFRESH_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INVENTORY_INDEX_REFRESH_MS;
})();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Global error safety net ────────────────────────────────────────────────────
// Catch async errors that escaped every try/catch. Log them but don't crash
// the process — the request will time out rather than taking the whole server down.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});

// Uncaught synchronous exceptions are unrecoverable — log and exit so the
// workflow manager can restart the process cleanly.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

// ── Port-conflict retry ────────────────────────────────────────────────────────
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1_000;

function startServer(retries: number): void {
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");

    // Warm the in-memory Fuse index, then begin the refresh schedule.
    // Initial build errors are logged but non-fatal so the server can
    // still serve Postgres-only traffic.
    void refreshInventoryIndex().finally(() => {
      startInventoryIndex(inventoryIndexRefreshMs);
    });

    // ── Graceful shutdown ──────────────────────────────────────────────────────
    // Stop accepting new connections, drain in-flight requests, then close the
    // DB pool. Forced exit after 10 s if drain takes too long (e.g. hung SSE).
    const shutdown = (signal: string) => {
      logger.info({ signal }, "Shutdown signal — draining connections…");

      // Cancel the index refresh timer first so it can't fire mid-shutdown.
      stopInventoryIndex();

      server.close(async () => {
        logger.info("HTTP server closed");
        try {
          await pool.end();
          logger.info("Database pool closed");
        } catch (err) {
          logger.error({ err }, "Error closing database pool");
        }
        process.exit(0);
      });

      setTimeout(() => {
        logger.warn("Graceful shutdown timed out after 10 s — forcing exit");
        process.exit(1);
      }, 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && retries > 0) {
      logger.warn(
        { port, retriesLeft: retries - 1 },
        "Port in use — retrying in 1s…",
      );
      server.close();
      setTimeout(() => startServer(retries - 1), RETRY_DELAY_MS);
    } else {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
  });
}

startServer(MAX_RETRIES);
