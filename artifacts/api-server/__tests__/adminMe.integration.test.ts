/**
 * Integration tests for GET /api/admin/me.
 *
 * Verifies:
 * - Returns { isAdmin: true }  for the bootstrap admin (ADMIN_CLERK_USER_ID).
 * - Returns { isAdmin: false } for a regular approved user (role = "user").
 * - Returns { isAdmin: true }  for a promoted admin user (role = "admin").
 * - Returns 401 for unauthenticated requests.
 */

jest.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: jest.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

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

jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  })),
);

import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { closePool } from "./helpers/testDb";
import { db, usersTable } from "@workspace/db";

afterAll(async () => {
  await closePool();
}, 15_000);

describe("GET /api/admin/me", () => {
  it("returns { isAdmin: true } for the bootstrap admin (ADMIN_CLERK_USER_ID)", async () => {
    const token = signAdminToken();
    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isAdmin: true });
  });

  it("returns { isAdmin: false } for an approved non-admin user", async () => {
    const userId = "me-test-nonadmin-user";
    await db
      .insert(usersTable)
      .values({ clerkUserId: userId, status: "approved", role: "user" })
      .onConflictDoNothing();

    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isAdmin: false });
  });

  it("returns { isAdmin: true } for a promoted admin user (role = admin)", async () => {
    const userId = "me-test-promoted-admin";
    await db
      .insert(usersTable)
      .values({ clerkUserId: userId, status: "approved", role: "admin" })
      .onConflictDoNothing();

    const res = await supertest(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${userId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isAdmin: true });
  });

  it("returns 401 for unauthenticated requests", async () => {
    const res = await supertest(app).get("/api/admin/me");
    expect(res.status).toBe(401);
  });
});
