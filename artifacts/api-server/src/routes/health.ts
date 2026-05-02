/**
 * Liveness/readiness probes. `/healthz` is wired into the deployment's
 * startup health check (see `.replit-artifact/artifact.toml`) so a
 * deploy is only considered green once the API can serve traffic.
 */
import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
