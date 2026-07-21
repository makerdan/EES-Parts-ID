/**
 * Integration tests for DELETE /api/user/me (self-service account deletion).
 *
 * Exercises the real database (users table) with JEST-prefixed Clerk user ids.
 * The @clerk/express stub reads `Authorization: Bearer <token>` as the Clerk
 * user id; clerkClient.users.deleteUser succeeds silently unless spied on.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
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
import { clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import supertest from "supertest";

import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";

const USER_PREFIX = "jest-userdel-";

async function seedApprovedUser(clerkUserId: string): Promise<void> {
  await db
    .insert(usersTable)
    .values({ clerkUserId, email: `${clerkUserId}@test.example`, status: "approved", role: "user" })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: "approved", role: "user" },
    });
}

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = ADMIN_TEST_USER_ID;
  // Deliberately NOT setting TEST_DEFAULT_AUTH_USER so requests without a
  // Bearer token are unauthenticated.
  delete process.env.TEST_DEFAULT_AUTH_USER;
});

afterAll(async () => {
  delete process.env.ADMIN_CLERK_USER_ID;
  await db.delete(usersTable).where(like(usersTable.clerkUserId, `${USER_PREFIX}%`));
}, 15_000);

afterEach(() => {
  jest.restoreAllMocks();
});

describe("DELETE /api/user/me", () => {
  it("returns 401 when no session is present", async () => {
    const res = await supertest(app).delete("/api/user/me").expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when the bootstrap admin tries to delete itself", async () => {
    const res = await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(400);

    expect(res.body.error).toMatch(/bootstrap admin/i);
  });

  it("deletes an approved user's own account and returns 204", async () => {
    const userId = `${USER_PREFIX}happy`;
    await seedApprovedUser(userId);

    await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(204);

    const remaining = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));
    expect(remaining).toHaveLength(0);
  });

  it("subsequent requests from a deleted user are treated as a new pending user (403)", async () => {
    const userId = `${USER_PREFIX}gone`;
    await seedApprovedUser(userId);

    await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(204);

    // requireAppAuth re-creates the user as pending — access is now blocked
    const res = await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(403);
    expect(res.body.code).toBe("pending");
  });

  it("returns 502 when the DB row is removed but the Clerk deletion fails", async () => {
    const userId = `${USER_PREFIX}clerkfail`;
    await seedApprovedUser(userId);

    jest
      .spyOn(clerkClient.users, "deleteUser")
      .mockRejectedValueOnce(new Error("clerk down"));

    const res = await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(502);

    expect(res.body.error).toMatch(/identity provider/i);

    // DB row must already be gone despite the Clerk failure
    const remaining = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));
    expect(remaining).toHaveLength(0);
  });

  it("returns 500 when the DB delete itself fails", async () => {
    const userId = `${USER_PREFIX}dbfail`;
    await seedApprovedUser(userId);

    const deleteSpy = jest.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("db down");
    });

    const res = await supertest(app)
      .delete("/api/user/me")
      .set("Authorization", `Bearer ${userId}`)
      .expect(500);

    expect(res.body.error).toMatch(/failed to delete/i);
    deleteSpy.mockRestore();

    // Row still present — nothing was deleted
    const remaining = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, userId));
    expect(remaining).toHaveLength(1);
  });
});
