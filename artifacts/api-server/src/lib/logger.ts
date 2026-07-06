import type { Response } from "express";
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

/**
 * Returns the per-request child logger set by the requestId middleware
 * (`res.locals.logger`), or falls back to the global logger when called
 * outside a request context.  Use this in route handlers so every log line
 * automatically includes the `requestId` field.
 */
export function getLogger(res: Response): typeof logger {
  return (res.locals.logger as typeof logger | undefined) ?? logger;
}
