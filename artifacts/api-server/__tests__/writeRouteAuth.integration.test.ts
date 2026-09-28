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
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupTestUser,
  seedTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = workerQualifiedUserId("jest-writeauth-user");
const PENDING_USER = workerQualifiedUserId("jest-writeauth-pending");
const BANNED_USER = workerQualifiedUserId("jest-writeauth-banned");

beforeAll(async () => {
  // seedTestUser derives the email from the clerkUserId, so parallel suites
  // can never collide on users_email_unique, and re-seeding is an idempotent
  // upsert on clerk_user_id (safe when two workers race).
  await Promise.all([
    seedTestUser({ clerkUserId: NON_ADMIN_USER, status: "approved", role: "user" }),
    seedTestUser({ clerkUserId: PENDING_USER, status: "pending", role: "admin" }),
    seedTestUser({ clerkUserId: BANNED_USER, status: "banned", role: "admin" }),
  ]);
});

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(NON_ADMIN_USER),
    cleanupTestUser(PENDING_USER),
    cleanupTestUser(BANNED_USER),
  ]);
}, 15_000);

describe("user fixture ownership", () => {
  it("keeps a concurrent-run decoy when this worker cleans up its user", async () => {
    const ownedUser = workerQualifiedUserId("jest-writeauth-cleanup");
    const concurrentRunDecoy = workerQualifiedUserId(
      "jest-writeauth-cleanup",
      "other-process-1",
    );

    await Promise.all([
      seedTestUser({ clerkUserId: ownedUser }),
      seedTestUser({ clerkUserId: concurrentRunDecoy }),
    ]);

    await cleanupTestUser(ownedUser);

    const remainingDecoy = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, concurrentRunDecoy));

    expect(remainingDecoy).toEqual([{ clerkUserId: concurrentRunDecoy }]);
    await cleanupTestUser(concurrentRunDecoy);
  });
});

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

const INVENTORY_MUTATION_ROUTES: ReadonlyArray<{
  label: string;
  send: (token: string) => supertest.Test;
}> = [
  {
    label: "POST /api/inventory/add-part",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/add-part"), token).send({}),
  },
  {
    label: "POST /api/inventory/upsert-batch/preview",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/upsert-batch/preview"), token).send({}),
  },
  {
    label: "POST /api/inventory/upsert-batch",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/upsert-batch"), token).send({}),
  },
  {
    label: "POST /api/inventory/enrich",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/enrich"), token).send({}),
  },
  {
    label: "POST /api/inventory/description-expansion",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/description-expansion"), token).send({}),
  },
  {
    label: "DELETE /api/inventory/description-expansion",
    send: (token) =>
      withAuth(supertest(app).delete("/api/inventory/description-expansion"), token).send({}),
  },
  {
    label: "POST /api/inventory/expand-descriptions",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/expand-descriptions"), token).send({}),
  },
  {
    label: "POST /api/inventory/:id/expand-description",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/1/expand-description"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/expanded-description",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/expanded-description"), token).send({}),
  },
  {
    label: "POST /api/inventory/bulk-enrich",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/bulk-enrich"), token).send({}),
  },
  {
    label: "DELETE /api/inventory/bulk-enrich",
    send: (token) =>
      withAuth(supertest(app).delete("/api/inventory/bulk-enrich"), token).send({}),
  },
  {
    label: "POST /api/inventory/enrich-measurements",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/enrich-measurements"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/barcodes",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/barcodes"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/bins",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/bins"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/order",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/order"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/size",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/size"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/description",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/description"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/enrich",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/enrich"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/keywords",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/keywords"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/photo",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/photo"), token).send({}),
  },
  {
    label: "PATCH /api/inventory/:id/dimensions",
    send: (token) =>
      withAuth(supertest(app).patch("/api/inventory/1/dimensions"), token).send({}),
  },
  {
    label: "POST /api/inventory/estimate-dimensions",
    send: (token) =>
      withAuth(supertest(app).post("/api/inventory/estimate-dimensions"), token).send({}),
  },
  {
    label: "DELETE /api/inventory/:id",
    send: (token) =>
      withAuth(supertest(app).delete("/api/inventory/1"), token).send({}),
  },
];

for (const { label, send } of INVENTORY_MUTATION_ROUTES) {
  describe(`${label} — blocked account guard`, () => {
    it("pending → 403 with pending code", async () => {
      const res = await send(PENDING_USER).expect(403);
      expect(res.body).toMatchObject({ code: "pending" });
    });

    it("banned → 403 with banned code", async () => {
      const res = await send(BANNED_USER).expect(403);
      expect(res.body).toMatchObject({ code: "banned" });
    });
  });
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

describe("PATCH /api/inventory/:id/description — auth guard", () => {
  function send(token?: string): supertest.Test {
    return withAuth(
      supertest(app).patch("/api/inventory/1/description"),
      token,
    ).send({ description: "auth boundary coverage" });
  }

  it("unauthenticated → 401", async () => {
    await send().expect(401);
  });

  it("approved non-admin → 403", async () => {
    await send(NON_ADMIN_USER).expect(403);
  });

  it("pending → 403", async () => {
    const res = await send(PENDING_USER).expect(403);
    expect(res.body).toMatchObject({ code: "pending" });
  });

  it("banned → 403", async () => {
    const res = await send(BANNED_USER).expect(403);
    expect(res.body).toMatchObject({ code: "banned" });
  });

  it("approved admin passes authentication without an MFA_REQUIRED response", async () => {
    const res = await send(ADMIN_TOKEN);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.body.code).not.toBe("MFA_REQUIRED");
  });
});
