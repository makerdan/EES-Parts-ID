/**
 * API route access contract.
 *
 * This is deliberately explicit rather than inferred from URL prefixes. A
 * route's sensitivity is a contract that should be reviewed when a route is
 * added or changed:
 *
 *   public        — no Clerk session; only health and warehouse layout reads
 *   approved-user — valid Clerk session mapped to an approved application user
 *   admin-only    — approved admin role and the current session's MFA factor
 *
 * The common approved-user guard is mounted once in app.ts. Admin routes also
 * carry requireAdminAuth at their individual route declaration so the
 * privileged boundary remains visible next to the handler.
 */

type RouteAccess = "public" | "approved-user" | "admin-only";
type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteAccessEntry = {
  method: RouteMethod;
  path: string;
  access: RouteAccess;
};

export const ROUTE_ACCESS_MATRIX: ReadonlyArray<RouteAccessEntry> = [
  // Health and intentional public warehouse layout reads.
  { method: "GET", path: "/api/healthz", access: "public" },
  { method: "GET", path: "/api/floor-plan/meta", access: "public" },
  { method: "GET", path: "/api/floor-plan/svg", access: "public" },
  { method: "GET", path: "/api/floor-plan/tiles/:z/:x/:y", access: "public" },

  // Authentication and ordinary application access.
  { method: "GET", path: "/api/auth/status", access: "approved-user" },
  { method: "POST", path: "/api/ai/identify", access: "approved-user" },
  { method: "POST", path: "/api/ai/translate-query", access: "approved-user" },
  { method: "POST", path: "/api/ai/part-card", access: "approved-user" },
  { method: "POST", path: "/api/ai/reference", access: "approved-user" },
  { method: "POST", path: "/api/contact", access: "approved-user" },
  { method: "GET", path: "/api/dictionaries/lookup", access: "approved-user" },
  { method: "POST", path: "/api/floor-plan/tiles/warmup", access: "approved-user" },
  { method: "GET", path: "/api/help", access: "approved-user" },
  { method: "POST", path: "/api/help/ask", access: "approved-user" },
  { method: "GET", path: "/api/inventory", access: "approved-user" },
  { method: "POST", path: "/api/inventory/search", access: "approved-user" },
  { method: "GET", path: "/api/inventory/categories", access: "approved-user" },
  { method: "GET", path: "/api/inventory/barcode/:barcode", access: "approved-user" },
  { method: "GET", path: "/api/inventory/:id/photo", access: "approved-user" },
  { method: "POST", path: "/api/reference/ask", access: "approved-user" },
  { method: "GET", path: "/api/reference/quick-lookups", access: "approved-user" },
  { method: "GET", path: "/api/reference/quick-lookups/:label", access: "approved-user" },
  { method: "POST", path: "/api/track/screen-view", access: "approved-user" },
  { method: "DELETE", path: "/api/user/me", access: "approved-user" },
  { method: "GET", path: "/api/warehouse-zones", access: "public" },
  { method: "GET", path: "/api/warehouse-zones/anchors", access: "public" },
  { method: "GET", path: "/api/warehouse-zones/coverage", access: "approved-user" },
  { method: "GET", path: "/api/warehouse-zones/alignment", access: "public" },

  // Admin self-check intentionally remains callable by any approved user.
  { method: "GET", path: "/api/admin/me", access: "approved-user" },

  // Administrative settings, identity management, observability, and writes.
  { method: "GET", path: "/api/admin/profile", access: "admin-only" },
  { method: "PUT", path: "/api/admin/profile", access: "admin-only" },
  { method: "GET", path: "/api/admin/shelf-preferences", access: "admin-only" },
  { method: "PATCH", path: "/api/admin/shelf-preferences", access: "admin-only" },
  { method: "GET", path: "/api/admin/ai-provider", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-provider", access: "admin-only" },
  { method: "POST", path: "/api/admin/restart", access: "admin-only" },
  { method: "GET", path: "/api/admin/users", access: "admin-only" },
  { method: "POST", path: "/api/admin/users/:clerkUserId/approve", access: "admin-only" },
  { method: "POST", path: "/api/admin/users/:clerkUserId/ban", access: "admin-only" },
  { method: "POST", path: "/api/admin/users/:clerkUserId/promote", access: "admin-only" },
  { method: "POST", path: "/api/admin/users/:clerkUserId/demote", access: "admin-only" },
  { method: "DELETE", path: "/api/admin/users/:clerkUserId", access: "admin-only" },
  { method: "GET", path: "/api/admin/audit-log", access: "admin-only" },
  { method: "POST", path: "/api/admin/upload/preview", access: "admin-only" },
  { method: "POST", path: "/api/admin/upload", access: "admin-only" },
  { method: "POST", path: "/api/admin/upload/orders/preview", access: "admin-only" },
  { method: "POST", path: "/api/admin/upload/orders", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/:jobId/cancel", access: "admin-only" },
  { method: "GET", path: "/api/admin/catalog-pdf/:jobId/status", access: "admin-only" },
  { method: "GET", path: "/api/admin/catalog-pdf/failed-jobs", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/:jobId/resume", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/:jobId/dismiss", access: "admin-only" },
  { method: "GET", path: "/api/admin/catalog-pdf/reviews", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/reviews/:id/revert", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/upload-sessions", access: "admin-only" },
  { method: "GET", path: "/api/admin/catalog-pdf/upload-sessions/:sessionId", access: "admin-only" },
  { method: "PUT", path: "/api/admin/catalog-pdf/upload-sessions/:sessionId/parts/:partIndex", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/upload-sessions/:sessionId/complete", access: "admin-only" },
  { method: "POST", path: "/api/admin/catalog-pdf/upload-sessions/:sessionId/cancel", access: "admin-only" },
  { method: "GET", path: "/api/contact", access: "admin-only" },
  { method: "PATCH", path: "/api/contact/:id/read", access: "admin-only" },
  { method: "GET", path: "/api/admin/dashboard-stats", access: "admin-only" },
  { method: "POST", path: "/api/admin/query", access: "admin-only" },
  { method: "GET", path: "/api/admin/ai-status", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/catalogue/refresh", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/refresh", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/probe", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/probe/:botName", access: "admin-only" },
  { method: "PUT", path: "/api/admin/ai-status/routes", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/fallbacks", access: "admin-only" },
  { method: "POST", path: "/api/admin/ai-status/routes/reset", access: "admin-only" },
  { method: "GET", path: "/api/admin/map-anchors", access: "admin-only" },
  { method: "PUT", path: "/api/admin/map-anchors/:slot", access: "admin-only" },
  { method: "DELETE", path: "/api/admin/map-anchors/:slot", access: "admin-only" },
  { method: "POST", path: "/api/admin/floor-plan", access: "admin-only" },
  { method: "POST", path: "/api/inventory/add-part", access: "admin-only" },
  { method: "POST", path: "/api/inventory/upsert-batch/preview", access: "admin-only" },
  { method: "POST", path: "/api/inventory/upsert-batch", access: "admin-only" },
  { method: "POST", path: "/api/inventory/enrich", access: "admin-only" },
  { method: "GET", path: "/api/inventory/enrich-summary", access: "admin-only" },
  { method: "POST", path: "/api/inventory/expand-descriptions", access: "admin-only" },
  { method: "POST", path: "/api/inventory/:id/expand-description", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/expanded-description", access: "admin-only" },
  { method: "POST", path: "/api/inventory/bulk-enrich", access: "admin-only" },
  { method: "GET", path: "/api/inventory/bulk-enrich/status", access: "admin-only" },
  { method: "DELETE", path: "/api/inventory/bulk-enrich", access: "admin-only" },
  { method: "POST", path: "/api/inventory/enrich-measurements", access: "admin-only" },
  { method: "GET", path: "/api/inventory/enrich-measurements/status", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/barcodes", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/bins", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/order", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/size", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/description", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/enrich", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/keywords", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/photo", access: "admin-only" },
  { method: "PATCH", path: "/api/inventory/:id/dimensions", access: "admin-only" },
  { method: "POST", path: "/api/inventory/estimate-dimensions/search", access: "approved-user" },
  { method: "POST", path: "/api/inventory/estimate-dimensions", access: "admin-only" },
  { method: "DELETE", path: "/api/inventory/:id", access: "admin-only" },
  { method: "PUT", path: "/api/warehouse-zones/alignment", access: "admin-only" },
  { method: "POST", path: "/api/warehouse-zones", access: "admin-only" },
  { method: "PATCH", path: "/api/warehouse-zones/:id", access: "admin-only" },
  { method: "DELETE", path: "/api/warehouse-zones/:id", access: "admin-only" },
  { method: "POST", path: "/api/reference/quick-lookups/:label", access: "admin-only" },
  { method: "GET", path: "/api/reference/ask-log", access: "admin-only" },
  { method: "GET", path: "/api/help/admin", access: "admin-only" },
];

function normalizePath(path: string): string {
  const withoutApiPrefix = path.startsWith("/api/") ? path.slice(4) : path;
  const withoutTrailingSlash = withoutApiPrefix.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function matchesTemplate(template: string, actualPath: string): boolean {
  const templateParts = normalizePath(template).split("/").filter(Boolean);
  const actualParts = normalizePath(actualPath).split("/").filter(Boolean);
  return (
    templateParts.length === actualParts.length &&
    templateParts.every((part, index) => part.startsWith(":") || part === actualParts[index])
  );
}

/**
 * Public access is method-aware. In particular, the public tile GET prefix
 * must not make the tile warmup POST public.
 */
export function isPublicRoute(method: string, path: string): boolean {
  // A malformed/direct unit request without method metadata must never become
  // public by default.
  if (typeof method !== "string") return false;
  const normalizedMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return ROUTE_ACCESS_MATRIX.some(
    (entry) =>
      entry.access === "public" &&
      entry.method === normalizedMethod &&
      matchesTemplate(entry.path, path),
  );
}