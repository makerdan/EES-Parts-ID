/**
 * Route-access regression guard.
 *
 * The matrix is the reviewable contract for every mounted API endpoint. This
 * test also scans literal router declarations so adding a new route without a
 * matrix entry fails in CI instead of silently inheriting an accidental access
 * level.
 */

// Keep app imports on the CJS Jest path. The real integration package pulls in
// ESM-only retry utilities that are not part of this authorization test.
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

import fs from "node:fs";
import path from "node:path";

import supertest from "supertest";

import { ROUTE_ACCESS_MATRIX } from "../src/routes/routeAccessMatrix";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { cleanupTestUser, seedTestUser } from "./helpers/testDb";

const APPROVED_USER = "jest-route-matrix-approved";
const PENDING_USER = "jest-route-matrix-pending";
const BANNED_USER = "jest-route-matrix-banned";

const ROUTE_MOUNTS: Record<string, string> = {
  admin: "/api/admin",
  adminAiStatus: "/api/admin",
  adminDashboard: "/api/admin",
  adminQuery: "/api/admin",
  adminUpload: "/api/admin",
  ai: "/api/ai",
  auth: "/api/auth",
  catalogPdf: "/api/admin",
  catalogPdfUpload: "/api/admin",
  contact: "/api/contact",
  dictionaries: "/api/dictionaries",
  floorPlan: "/api",
  health: "/api",
  help: "/api/help",
  inventory: "/api/inventory",
  inventoryCategories: "/api/inventory",
  mapAnchors: "/api/admin",
  reference: "/api/reference",
  track: "/api/track",
  user: "/api/user",
  warehouseZones: "/api/warehouse-zones",
};

function matrixKey(method: string, routePath: string): string {
  const normalized = routePath.replace(/\/+$/, "") || "/";
  return `${method.toUpperCase()} ${normalized}`;
}

function matrixKeys(): Set<string> {
  return new Set(ROUTE_ACCESS_MATRIX.map((entry) => matrixKey(entry.method, entry.path)));
}

function literalRouteDeclarations(): Array<{ method: string; path: string }> {
  const routesDir = path.resolve(__dirname, "../src/routes");
  const declarations: Array<{ method: string; path: string }> = [];
  const declarationPattern =
    /router\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

  for (const fileName of fs.readdirSync(routesDir)) {
    if (!fileName.endsWith(".ts") || fileName === "index.ts" || fileName === "routeAccessMatrix.ts") continue;
    const source = fs.readFileSync(path.join(routesDir, fileName), "utf8");
    const moduleName = fileName.replace(/\.ts$/, "");
    const mount = ROUTE_MOUNTS[moduleName];
    if (!mount) throw new Error(`Missing route mount for ${fileName}`);

    for (const match of source.matchAll(declarationPattern)) {
      const localPath = match[2]!;
      const fullPath = `${mount}/${localPath}`.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
      declarations.push({ method: match[1]!, path: fullPath });
    }
  }

  // This route intentionally uses a regular expression because barcode values
  // may contain characters that are not safe to express as a named segment.
  declarations.push({ method: "get", path: "/api/inventory/barcode/:barcode" });
  return declarations;
}

beforeAll(async () => {
  await Promise.all([
    seedTestUser({ clerkUserId: APPROVED_USER, status: "approved", role: "user" }),
    seedTestUser({ clerkUserId: PENDING_USER, status: "pending", role: "user" }),
    seedTestUser({ clerkUserId: BANNED_USER, status: "banned", role: "user" }),
  ]);
});

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(APPROVED_USER),
    cleanupTestUser(PENDING_USER),
    cleanupTestUser(BANNED_USER),
  ]);
}, 15_000);

describe("route access matrix completeness", () => {
  it("classifies every literal and dynamic mounted endpoint", () => {
    const keys = matrixKeys();
    const missing = literalRouteDeclarations()
      .map(({ method, path: routePath }) => matrixKey(method, routePath))
      .filter((key) => !keys.has(key));

    expect(missing).toEqual([]);
  });

  it("keeps public access limited to health and warehouse layout reads", () => {
    const publicRoutes = ROUTE_ACCESS_MATRIX
      .filter((entry) => entry.access === "public")
      .map((entry) => `${entry.method} ${entry.path}`);

    expect(publicRoutes).toEqual([
      "GET /api/healthz",
      "GET /api/floor-plan/meta",
      "GET /api/floor-plan/svg",
      "GET /api/floor-plan/tiles/:z/:x/:y",
      "GET /api/warehouse-zones",
      "GET /api/warehouse-zones/anchors",
      "GET /api/warehouse-zones/alignment",
    ]);
  });
});

describe("matrix authorization behavior", () => {
  it("allows public health and layout reads without a Clerk session", async () => {
    await supertest(app).get("/api/healthz").expect((res) => {
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    await supertest(app).get("/api/floor-plan/meta").expect((res) => {
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  it("rejects unauthenticated access to ordinary, sensitive, and admin data", async () => {
    await supertest(app).get("/api/auth/status").expect(401);
    await supertest(app).get("/api/inventory").expect(401);
    await supertest(app).get("/api/admin/users").expect(401);
  });

  it("fails closed for pending and banned users", async () => {
    const pending = await supertest(app)
      .get("/api/auth/status")
      .set("Authorization", `Bearer ${PENDING_USER}`)
      .expect(403);
    expect(pending.body).toMatchObject({ code: "pending" });

    const banned = await supertest(app)
      .get("/api/auth/status")
      .set("Authorization", `Bearer ${BANNED_USER}`)
      .expect(403);
    expect(banned.body).toMatchObject({ code: "banned" });
  });

  it("gives an approved non-admin ordinary access but denies admin data", async () => {
    await supertest(app)
      .get("/api/auth/status")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .expect(200);

    const adminResponse = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${APPROVED_USER}`)
      .expect(403);
    expect(adminResponse.body).toHaveProperty("error");
  });

  it("recognizes the current bootstrap admin only after the Clerk session boundary", async () => {
    const response = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(200);
    expect(response.body).toEqual({ isAdmin: true });
  });

  it("does not make the tile warmup write public", async () => {
    await supertest(app).post("/api/floor-plan/tiles/warmup").expect(401);
  });
});