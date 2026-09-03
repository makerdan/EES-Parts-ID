import type { Application } from "express";
import type { Server } from "http";

import { logger } from "./logger";

export const MAX_RETRIES = 10;
export const RETRY_DELAY_MS = 2000;

export function startServer(
  app: Application,
  port: number,
  retries: number = MAX_RETRIES,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(port, () => {
      logger.info({ port }, "Server listening");
      resolve(server);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && retries > 0) {
        logger.warn(
          { port, retriesLeft: retries - 1 },
          "Port in use — retrying…",
        );
        server.close(() => {
          setTimeout(
            () => startServer(app, port, retries - 1, retryDelayMs).then(resolve),
            retryDelayMs,
          );
        });
      } else {
        if (err.code === "EADDRINUSE") {
          logger.error(
            {
              err,
              port,
              recoveryCommand: `node scripts/free-ports.mjs ${port}`,
            },
            "Port is already in use; stop the owning development process or run the canonical recovery command",
          );
        } else {
          logger.error({ err }, "Error listening on port");
        }
        process.exit(1);
      }
    });
  });
}
