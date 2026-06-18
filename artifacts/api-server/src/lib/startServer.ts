import type { Application } from "express";
import { logger } from "./logger";

export const MAX_RETRIES = 5;
export const RETRY_DELAY_MS = 1000;

export function startServer(
  app: Application,
  port: number,
  retries: number = MAX_RETRIES,
  retryDelayMs: number = RETRY_DELAY_MS,
): void {
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && retries > 0) {
      logger.warn(
        { port, retriesLeft: retries - 1 },
        "Port in use — retrying in 1s…",
      );
      server.close(() => {
        setTimeout(
          () => startServer(app, port, retries - 1, retryDelayMs),
          retryDelayMs,
        );
      });
    } else {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
  });
}
