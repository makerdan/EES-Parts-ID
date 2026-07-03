import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireAppAuth } from "./middlewares/requireAppAuth";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

// Trust the single reverse-proxy hop in front of this server (Replit's edge).
// This makes req.ip resolve to the real client IP from X-Forwarded-For rather
// than the proxy's address, without allowing clients to spoof arbitrary IPs.
app.set("trust proxy", 1);

// Clerk proxy must be mounted BEFORE body parsers — it streams raw bytes.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// Restrict origins to the known Expo and web client origins.
// In production, set CORS_ALLOWED_ORIGINS to a comma-separated list of allowed
// origins (e.g. "https://app.example.com,https://admin.example.com").
// In development, all localhost origins are allowed when the env var is absent.
const isDev = process.env.NODE_ENV !== "production";
const rawAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

if (!isDev && !rawAllowedOrigins) {
  logger.warn(
    "CORS_ALLOWED_ORIGINS is not set in production — all origins are denied. " +
    "Set this env var to a comma-separated list of allowed origins.",
  );
}

const allowedOrigins: string[] = rawAllowedOrigins
  ? rawAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin requests (no Origin header) are always allowed.
      if (!origin) return callback(null, true);

      // In development with no explicit allowlist, permit all localhost origins.
      if (isDev && !rawAllowedOrigins) {
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        // Also allow Replit dev domain tunnels in development.
        if (/\.replit\.dev$/.test(origin) || /\.repl\.co$/.test(origin) || /\.replit\.app$/.test(origin)) {
          return callback(null, true);
        }
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      callback(new Error(`CORS: origin ${origin} is not allowed`));
    },
    credentials: true,
  }),
);
// Increase body limit for base64 payloads (AI photo identify + PDF catalog upload)
// A 25 MB PDF base64-encodes to ~34 MB; set limit to 50 MB to provide headroom.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Clerk middleware resolves the publishable key from the incoming request host
// so the same server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", requireAppAuth);
app.use("/api", router);

export default app;
