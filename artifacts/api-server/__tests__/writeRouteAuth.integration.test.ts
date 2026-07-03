/**
 * Regression guard: every write route protected by requireAdminAuth must reject
 * unauthenticated and non-admin requests forever.
 *
 * Auth model (see auth.integration.test.ts):
 *   - No Clerk session → 401
 *   - Authenticated, approved, non-admin → 403
 *   - Bootstrap admin → passes the auth layer
 *
 * The @clerk/express mock reads `Authorization: Bearer <token>` as the Clerk
 * user id, so a "token" here is just a Clerk user id.
 *
 * Covered endpoints:
 *   POST   /api/warehouse-zones
 *   PATCH  /api/warehouse-zones/:id
 *   DELETE /api/warehouse-zones/:id
 *   POST   /api/reference/quick-lookups/:label
 *   PATCH  /api/inventory/:id/keywords
 */

// ── Mock OpenAI before app is imported ────────────────────────────────────────
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

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, usersTable } from "@workspace/db";
import { like } from "drizzle-orm";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = "jest-writeauth-user";

beforeAll(async () => {
  await db
    .insert(usersTable)
    .values({ clerkUserId: NON_ADMIN_USER, email: "u@test.example", status: "approved", role: "user" })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: usersTable.status, role: usersTable.role },
    });
});

afterAll(async () => {
  await db.delete(usersTable).where(like(usersTable.clerkUserId, "jest-writeauth-%"));
  await closePool();
}, 15_000);

/** Runs the standard no-token / non-admin / admin assertions for one route. */
function describeWriteGuard(
  label: string,
  send: (token?: string) => supertest.Test,
) {
  describe(`${label} — auth guard`, () => {
    it("no token → 401", async () => {
      const res = await send().expect(401);
      expect(res.body).toHaveProperty("error");
    });

    it("approved non-admin → 403", async () => {
      const res = await send(NON_ADMIN_USER).expect(403);
      expect(res.body).toHaveProperty("error");
    });

    it("admin → passes auth (not 401/403)", async () => {
      const res = await send(ADMIN_TOKEN);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
}

function withAuth(t: supertest.Test, token?: string): supertest.Test {
  return token ? t.set("Authorization", `Bearer ${token}`) : t;
}

describeWriteGuard("POST /api/warehouse-zones", (token) =>
  withAuth(
    supertest(app).post("/api/warehouse-zones"),
    token,
  ).send({ aisleId: "JEST-W", svgX: 0, svgY: 0, svgWidth: 10, svgHeight: 10 }),
);

describeWriteGuard("PATCH /api/warehouse-zones/:id", (token) =>
  withAuth(supertest(app).patch("/api/warehouse-zones/1"), token).send({ svgX: 5 }),
);

describeWriteGuard("DELETE /api/warehouse-zones/:id", (token) =>
  withAuth(supertest(app).delete("/api/warehouse-zones/1"), token),
);

describeWriteGuard("POST /api/reference/quick-lookups/:label", (token) =>
  withAuth(
    supertest(app).post("/api/reference/quick-lookups/test-label"),
    token,
  ).send({ question: "What is the part number?" }),
);

describeWriteGuard("PATCH /api/inventory/:id/keywords", (token) =>
  withAuth(supertest(app).patch("/api/inventory/1/keywords"), token).send({
    keywords: ["motor", "bearing"],
  }),
);
