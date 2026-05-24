import type { Request, Response, NextFunction } from "express";

/**
 * devOnly — blocks the route with 403 when NODE_ENV is "production".
 *
 * Evaluated per-request (not cached at module load) so that tests can
 * toggle process.env.NODE_ENV and get the expected response.
 */
export function devOnly(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "This endpoint is disabled in production" });
    return;
  }
  next();
}
