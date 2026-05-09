/**
 * Liveness/readiness probes. `/healthz` is wired into the deployment's
 * startup health check (see `.replit-artifact/artifact.toml`) so a
 * deploy is only considered green once the API can serve traffic.
 *
 * Returns 503 while the quick-lookup cache seeder is still running so that
 * the Replit proxy does not route production traffic until all 12 chip
 * answers are pre-populated in the DB — guaranteeing every chip tap is
 * instant from the very first request.
 */
import { Router, type IRouter } from 'express';
import { HealthCheckResponse } from '@workspace/api-zod';
import { isQuickLookupSeederReady } from '../lib/seedQuickLookups';

const router: IRouter = Router();

router.get('/healthz', (_req, res) => {
  if (!isQuickLookupSeederReady()) {
    return void res.status(503).json({ status: 'seeding' });
  }
  const data = HealthCheckResponse.parse({ status: 'ok' });
  res.json(data);
});

export default router;
