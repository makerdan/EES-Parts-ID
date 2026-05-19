import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { catalogPdfJobTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

async function recoverOrphanedJobs(): Promise<void> {
  try {
    const result = await db
      .update(catalogPdfJobTable)
      .set({
        status: "failed",
        errorMessage: "Server restarted while job was in progress. Please resubmit the PDF.",
        finishedAt: new Date(),
      })
      .where(eq(catalogPdfJobTable.status, "processing"))
      .returning({ id: catalogPdfJobTable.id });

    if (result.length > 0) {
      logger.warn(
        { orphanedJobIds: result.map((r) => r.id) },
        `Marked ${result.length} orphaned PDF job(s) as failed on startup`,
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to recover orphaned PDF jobs on startup");
  }
}

function startServer(retries: number): void {
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
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

recoverOrphanedJobs().then(() => {
  startServer(MAX_RETRIES);
});
