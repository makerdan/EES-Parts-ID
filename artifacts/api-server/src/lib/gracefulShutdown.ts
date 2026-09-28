import type { Server } from "node:http";

import { logger } from "./logger";

const DEFAULT_HARD_LIMIT_MS = 20_000;
const DEFAULT_BACKGROUND_DRAIN_TIMEOUT_MS = 10_000;

export type ShutdownReason = "SIGINT" | "SIGTERM" | "admin-restart";

export type GracefulShutdownDependencies = {
  server: Pick<Server, "close">;
  shutdownBackgroundWork: (timeoutMs: number) => Promise<void>;
  exit?: (code: number) => void;
  hardLimitMs?: number;
  backgroundDrainTimeoutMs?: number;
};

let requestShutdown: ((reason: ShutdownReason) => Promise<void>) | undefined;

/**
 * Installs the process-wide shutdown coordinator after the HTTP listener starts.
 * Every shutdown source shares the same in-flight promise and bounded cleanup.
 */
export function configureGracefulShutdown(
  dependencies: GracefulShutdownDependencies,
): (reason: ShutdownReason) => Promise<void> {
  const {
    server,
    shutdownBackgroundWork,
    exit = (code) => process.exit(code),
    hardLimitMs = DEFAULT_HARD_LIMIT_MS,
    backgroundDrainTimeoutMs = DEFAULT_BACKGROUND_DRAIN_TIMEOUT_MS,
  } = dependencies;
  let shutdownPromise: Promise<void> | undefined;

  requestShutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;

    logger.info({ reason }, "Shutdown requested — draining in-flight requests");

    shutdownPromise = new Promise<void>((resolve) => {
      let finalized = false;
      const finalize = (message: string): void => {
        if (finalized) return;
        finalized = true;
        logger.info(message);
        exit(0);
        resolve();
      };
      const hardLimitTimer = setTimeout(() => {
        logger.warn({ hardLimitMs }, "Shutdown hard limit reached — forcing exit");
        finalize("Shutdown finalized at the hard limit");
      }, hardLimitMs);
      hardLimitTimer.unref();

      const serverClosed = new Promise<void>((resolveServerClosed) => {
        server.close(() => resolveServerClosed());
      });

      void Promise.allSettled([
        shutdownBackgroundWork(backgroundDrainTimeoutMs),
        serverClosed,
      ]).then(() => {
        clearTimeout(hardLimitTimer);
        finalize("Server closed and background work drained — exiting cleanly");
      });
    });

    return shutdownPromise;
  };

  return requestShutdown;
}

export function requestGracefulShutdown(reason: ShutdownReason): Promise<void> {
  if (!requestShutdown) {
    return Promise.reject(new Error("Graceful shutdown coordinator is not configured"));
  }
  return requestShutdown(reason);
}

/** Test-only reset for app-only integration suites that do not start a listener. */
export function resetGracefulShutdownForTests(): void {
  requestShutdown = undefined;
}