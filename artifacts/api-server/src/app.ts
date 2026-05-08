/**
 * Express app factory.
 *
 * Composes the middleware stack (CORS, JSON body parser with a generous
 * limit for spreadsheet batches, pino-http request logging) and mounts
 * the route tree from `./routes`. Exported separately from `index.ts` so
 * supertest can drive the app in unit tests without binding a port.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import router from './routes';
import { logger } from './lib/logger';

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split('?')[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  })
);
app.use(cors());
// Increase body limit for base64 image payloads (AI photo identify)
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.use('/api', router);

export default app;
