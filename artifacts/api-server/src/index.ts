import app from "./app";
import { logger } from "./lib/logger";

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

startServer(MAX_RETRIES);
