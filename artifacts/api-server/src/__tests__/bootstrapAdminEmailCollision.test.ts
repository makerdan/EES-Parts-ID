/**
 * Regression test for the bootstrap-admin email collision bug.
 *
 * Since the bootstrap-admin branch of requireAppAuth backfills the admin's real
 * email into the admin's `users` row, an email-uniqueness collision became
 * possible: a *different* `users` row (different clerk_user_id) may already hold
 * that same email. The `users_email_unique` partial index then rejected the
 * write, the upsert (which only handles clerk_user_id conflicts) threw, and the
 * middleware 500'd every authenticated admin request — bouncing the admin back
 * to the login screen and making login itself appear broken.
 *
 * This suite proves the collision-safe path:
 *   1. The admin authenticates while another row already holds their email.
 *   2. The request succeeds (200), not 500.
 *   3. The rows consolidate to a single admin row keyed by the bootstrap
 *      admin's clerk_user_id, carrying the real email, role=admin,
 *      status=approved — no orphan row keeps the email.
 *
 * Auth model (see __mocks__/clerkExpress.cjs): the Bearer token IS the Clerk
 * user id, and clerkClient.users.getUser(id) resolves email `${id}@test.example`.
 * So the bootstrap admin's resolved email is `${ADMIN_TEST_USER_ID}@test.example`.
 */

// ── OpenAI / AI provider mocks so importing app.ts succeeds under Jest CJS ─────
jest.mock("openai", () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

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
import { eq, like } from "drizzle-orm";

import app from "../app";
import { ADMIN_TEST_USER_ID } from "../../__tests__/helpers/adminAuth";
import { db, usersTable } from "@workspace/db";

// The email the Clerk mock resolves for the bootstrap admin.
const ADMIN_EMAIL = `${ADMIN_TEST_USER_ID}@test.example`;

// A *different* clerk_user_id that starts out holding the admin's email — this
// is the row that triggers the uniqueness collision on backfill.
const FOREIGN_ROW_ID = "jest-collision-foreign";

function adminBearer(): string {
  return `Bearer ${ADMIN_TEST_USER_ID}`;
}

beforeEach(async () => {
  // Reproduce the confirmed broken state: two rows, both admin/approved — one
  // stale bootstrap-admin row with an empty email, and a separate row already
  // holding the admin's real email under a different clerk_user_id.
  await db.delete(usersTable).where(eq(usersTable.email, ADMIN_EMAIL));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, FOREIGN_ROW_ID));

  await db.insert(usersTable).values([
    {
      clerkUserId: ADMIN_TEST_USER_ID,
      email: "",
      status: "approved",
      role: "admin",
    },
    {
      clerkUserId: FOREIGN_ROW_ID,
      email: ADMIN_EMAIL,
      status: "approved",
      role: "admin",
    },
  ]);
});

afterAll(async () => {
  await db.delete(usersTable).where(like(usersTable.clerkUserId, "jest-collision-%"));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));
  await db.delete(usersTable).where(eq(usersTable.email, ADMIN_EMAIL));
}, 15_000);

describe("requireAppAuth — bootstrap admin email collision", () => {
  it("authenticated request succeeds (200, not 500) despite the email collision", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("isAdmin", true);
  });

  it("consolidates to a single admin row keyed by the bootstrap admin id with the real email", async () => {
    await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    // Exactly one row now holds the admin's email, and it is the bootstrap
    // admin's canonical row.
    const byEmail = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, ADMIN_EMAIL));

    expect(byEmail).toHaveLength(1);
    expect(byEmail[0]!.clerkUserId).toBe(ADMIN_TEST_USER_ID);
    expect(byEmail[0]!.role).toBe("admin");
    expect(byEmail[0]!.status).toBe("approved");

    // The foreign row that previously held the email is gone (no orphan).
    const foreign = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, FOREIGN_ROW_ID));
    expect(foreign).toHaveLength(0);
  });

  it("shows the real email on the bootstrap admin's card in the user list", async () => {
    await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    const res = await supertest(app)
      .get("/api/admin/users")
      .set("Authorization", adminBearer())
      .expect(200);

    const adminCard = res.body.users.find(
      (u: { clerkUserId: string }) => u.clerkUserId === ADMIN_TEST_USER_ID,
    );
    expect(adminCard).toBeDefined();
    expect(adminCard.email).toBe(ADMIN_EMAIL);
  });
});
