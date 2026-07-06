import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { requireAppAuth } from "./middlewares/requireAppAuth";
import router from "./routes";

const app: Express = express();

// Trust the single reverse-proxy hop in front of this server (Replit's edge).
// This makes req.ip resolve to the real client IP from X-Forwarded-For rather
// than the proxy's address, without allowing clients to spoof arbitrary IPs.
app.set("trust proxy", 1);

// ── Request ID ────────────────────────────────────────────────────────────────
// Assign a unique identifier to every request so logs and error responses can
// be correlated. The client may supply X-Request-Id (e.g. on a mobile retry);
// if present, that value is reused unchanged so the ID flows end-to-end.
app.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = req.headers["x-request-id"];
  const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.locals.logger = logger.child({ requestId });
  next();
});

// ── Security headers ───────────────────────────────────────────────────────────
// Mount helmet before CORS and body parsers so security headers are applied to
// every response including error responses from upstream middleware.
// HSTS is only set in production to avoid breaking local dev (http://localhost).
// The API serves JSON only — tighten CSP so it can't be used to load scripts,
// frames, or external resources from a browser context.
app.use(
  helmet({
    hsts: process.env.NODE_ENV === "production"
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

// Clerk proxy must be mounted BEFORE body parsers — it streams raw bytes.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  pinoHttp({
    logger,
    customProps(_req, res) {
      const requestId = (res as Response).locals?.requestId as string | undefined;
      return requestId ? { requestId } : {};
    },
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

const allowedOrigins: Array<string> = rawAllowedOrigins
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
// Pre-body-parse Content-Length guard for the dimension-estimation search endpoint.
// This route accepts a single image and now requires auth, but the global body
// parser below still runs before auth. Reject oversized Content-Length headers
// before the body is buffered to prevent large-payload exhaustion attacks on
// this path even from unauthenticated callers.
// A 10 MB image base64-encodes to ~13.4 MB; 15 MB gives generous headroom.
app.use("/api/inventory/estimate-dimensions/search", (req, res, next) => {
  const rawLen = req.headers["content-length"];
  if (rawLen !== undefined) {
    const len = parseInt(rawLen, 10);
    if (Number.isFinite(len) && len > 15 * 1024 * 1024) {
      res.status(413).json({ error: "Request body too large for this endpoint (max 15 MB)." });
      return;
    }
  }
  next();
});

// ── Per-route body size limits ─────────────────────────────────────────────────
// Upload routes accept large base64 payloads. All other routes are capped at
// 1 MB to prevent resource exhaustion via oversized payloads on lightweight
// endpoints (search, auth status, barcode lookup, etc.).
//
// The generous parsers are mounted BEFORE the global 1 MB parser so Express
// matches these specific paths first and uses the larger limit. The global
// parser then applies to everything else.
//
// A 25 MB PDF base64-encodes to ~34 MB; 50 MB provides headroom.
const LARGE_BODY_LIMIT = "50mb";
const UPLOAD_PATHS = [
  "/api/admin/catalog-pdf",
  "/api/admin/upload",      // CSV/bulk-import uploads (large text payloads)
  "/api/ai/identify",
  "/api/ai/translate-query",
  "/api/ai/part-card",
  // estimate-dimensions prefix covers both:
  //   POST /api/inventory/estimate-dimensions/search (user-facing, image)
  //   POST /api/inventory/estimate-dimensions        (admin, image)
  "/api/inventory/estimate-dimensions",
];
for (const p of UPLOAD_PATHS) {
  app.use(p, express.json({ limit: LARGE_BODY_LIMIT }));
  app.use(p, express.urlencoded({ extended: true, limit: LARGE_BODY_LIMIT }));
}

// Inventory photo upload (PATCH /api/inventory/:id/photo) — base64 image body.
// Dynamic path cannot be listed in UPLOAD_PATHS above; matched via regex.
const PHOTO_ROUTE_RE = /^\/api\/inventory\/[^/]+\/photo$/;
app.use(PHOTO_ROUTE_RE, express.json({ limit: LARGE_BODY_LIMIT }));
app.use(PHOTO_ROUTE_RE, express.urlencoded({ extended: true, limit: LARGE_BODY_LIMIT }));

// Global body parser — 1 MB cap for all other routes.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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

// ── Global error handler ─────────────────────────────────────────────────────
// Any error passed to next(err) by upstream middleware or route handlers (e.g.
// an unexpected DB failure inside requireAppAuth) lands here. Log it through the
// structured logger so it reaches the error log instead of being silently
// swallowed by Express's default handler, then return a generic 500 JSON
// response without leaking internal error details.
//
// The 4-argument signature is required for Express to treat this as an error
// handler rather than a normal middleware.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const requestId = res.locals.requestId as string | undefined;
  logger.error({ err, requestId }, "Unhandled error reached the global error handler");
  // If the response has already started, we cannot rewrite the status/body;
  // hand off to Express's default handler so the connection is torn down
  // correctly rather than left hanging.
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Internal server error", requestId });
});

export default app;
