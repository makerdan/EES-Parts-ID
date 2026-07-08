/**
 * Regression test for the bootstrap-admin "Clerk email fetch failed" fallback.
 *
 * requireAppAuth resolves the admin's email from Clerk on every request.  If
 * that Clerk lookup throws, the middleware must NOT lock the admin out: it falls
 * back to preserving whatever email is already stored and still forces
 * role=admin / status=approved before calling next().
 *
 * This suite proves the fallback path:
 *   1. clerkClient.users.getUser rejects for the bootstrap admin.
 *   2. The authenticated request still returns 200.
 *   3. The existing stored email is left untouched (not wiped).
 *   4. role=admin and status=approved are still forced on the row.
 *
 * Auth model (see __mocks__/clerkExpress.cjs): the Bearer token IS the Clerk
 * user id.  The per-test spy overrides getUser to simulate a network failure.
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
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/express";

import app from "../app";
import { ADMIN_TEST_USER_ID } from "../../__tests__/helpers/adminAuth";
import { closePool } from "../../__tests__/helpers/testDb";
import { db, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";

// An existing email stored on the bootstrap-admin row before the request.
// After a failed Clerk fetch this value must still be present — it must not
// be wiped or replaced.
const STORED_EMAIL = "stored-admin@test.example";

function adminBearer(): string {
  return `Bearer ${ADMIN_TEST_USER_ID}`;
}

let getUserSpy: jest.SpyInstance;

beforeEach(async () => {
  // Seed the bootstrap-admin row with a known stored email.
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));
  await db.insert(usersTable).values({
    clerkUserId: ADMIN_TEST_USER_ID,
    email: STORED_EMAIL,
    status: "approved",
    role: "admin",
  });

  // Make every Clerk getUser call throw to simulate a network / API failure.
  getUserSpy = jest
    .spyOn(clerkClient.users, "getUser")
    .mockRejectedValue(new Error("Clerk API unreachable"));
});

afterEach(() => {
  getUserSpy.mockRestore();
});

afterAll(async () => {
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));
  await closePool();
}, 15_000);

describe("requireAppAuth — bootstrap admin Clerk fetch failure", () => {
  it("authenticated request still returns 200 when Clerk getUser rejects", async () => {
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    expect(res.body).toHaveProperty("isAdmin", true);
  });

  it("leaves the existing stored email untouched after a failed Clerk fetch", async () => {
    await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe(STORED_EMAIL);
  });

  it("forces role=admin and status=approved even when the Clerk fetch fails", async () => {
    // Start with a row that somehow lost its role/status to simulate a worst-case
    // scenario — the fallback path must still enforce them.
    await db
      .update(usersTable)
      .set({ role: "user", status: "pending" })
      .where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));

    await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", adminBearer())
      .expect(200);

    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, ADMIN_TEST_USER_ID));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("admin");
    expect(rows[0]!.status).toBe("approved");
  });

  it("grants access and logs the error when BOTH Clerk fetch AND db write fail", async () => {
    // Simulate a broken DB connection on top of the already-failing Clerk fetch.
    // The outer catch in requireAppAuth must absorb the write error and still
    // call next() so the admin keeps access (returns 200 with isAdmin=true).
    const dbInsertSpy = jest
      .spyOn(db, "insert")
      .mockImplementationOnce(() => {
        throw new Error("DB connection lost");
      });

    const loggerErrorSpy = jest.spyOn(logger, "error");

    try {
      const res = await supertest(app)
        .get("/api/admin/me")
        .set("Authorization", adminBearer())
        .expect(200);

      expect(res.body).toHaveProperty("isAdmin", true);

      // The write failure must be logged — not silently swallowed.
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining("bootstrap admin row write failed"),
      );
    } finally {
      dbInsertSpy.mockRestore();
      loggerErrorSpy.mockRestore();
    }
  });
});
