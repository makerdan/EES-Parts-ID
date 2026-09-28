/**
 * Request-level authorization contract for the protected map mutations.
 *
 * The client route smoke suites use mocked Clerk state and mocked fetch calls.
 * This suite reaches the real Express app, requireAppAuth, and
 * requireAdminAuth, while the Jest Clerk replacement treats the bearer value
 * as a user id. Admin requests use invalid mutation input so they stop after
 * authorization and do not modify canonical map or warehouse data.
 */

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

import supertest from "supertest";

import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupTestUser,
  seedTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";

const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = workerQualifiedUserId("jest-protected-map-user");
const PENDING_USER = workerQualifiedUserId("jest-protected-map-pending-user");
const BANNED_USER = workerQualifiedUserId("jest-protected-map-banned-user");

type MutationRequest = (token?: string) => supertest.Test;
const blockedUsers: Array<[string, string, "pending" | "banned"]> = [
  ["pending", PENDING_USER, "pending"],
  ["banned", BANNED_USER, "banned"],
];

const protectedMutations: Array<[string, MutationRequest]> = [
  [
    "PUT /api/admin/map-anchors/:slot",
    (token) =>
      withAuth(
        supertest(app).put("/api/admin/map-anchors/1").send({}),
        token,
      ),
  ],
  [
    "DELETE /api/admin/map-anchors/:slot",
    (token) =>
      withAuth(
        supertest(app).delete("/api/admin/map-anchors/99"),
        token,
      ),
  ],
  [
    "PUT /api/warehouse-zones/alignment",
    (token) =>
      withAuth(
        supertest(app).put("/api/warehouse-zones/alignment").send({}),
        token,
      ),
  ],
  [
    "POST /api/warehouse-zones",
    (token) =>
      withAuth(supertest(app).post("/api/warehouse-zones").send({}), token),
  ],
  [
    "PATCH /api/warehouse-zones/:id",
    (token) =>
      withAuth(
        supertest(app).patch("/api/warehouse-zones/not-an-id").send({}),
        token,
      ),
  ],
  [
    "DELETE /api/warehouse-zones/:id",
    (token) =>
      withAuth(
        supertest(app).delete("/api/warehouse-zones/not-an-id"),
        token,
      ),
  ],
];

function withAuth(request: supertest.Test, token?: string): supertest.Test {
  return token ? request.set("Authorization", `Bearer ${token}`) : request;
}

let previousDefaultAuthUser: string | undefined;

beforeAll(async () => {
  // The Clerk Jest mock supports a per-file default identity. Remove it so
  // every no-token case below is genuinely unauthenticated.
  previousDefaultAuthUser = process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.TEST_DEFAULT_AUTH_USER;
  await seedTestUser({
    clerkUserId: NON_ADMIN_USER,
    status: "approved",
    role: "user",
  });
  await seedTestUser({
    clerkUserId: PENDING_USER,
    status: "pending",
    role: "user",
  });
  await seedTestUser({
    clerkUserId: BANNED_USER,
    status: "banned",
    role: "user",
  });
});

afterAll(async () => {
  await cleanupTestUser(NON_ADMIN_USER);
  await cleanupTestUser(PENDING_USER);
  await cleanupTestUser(BANNED_USER);
  if (previousDefaultAuthUser === undefined) {
    delete process.env.TEST_DEFAULT_AUTH_USER;
  } else {
    process.env.TEST_DEFAULT_AUTH_USER = previousDefaultAuthUser;
  }
}, 15_000);

describe.each(protectedMutations)("%s", (label, send) => {
  it(`${label} rejects unauthenticated requests`, async () => {
    const response = await send().expect(401);
    expect(response.body).toHaveProperty("error");
  });

  it(`${label} rejects an approved non-admin`, async () => {
    const response = await send(NON_ADMIN_USER).expect(403);
    expect(response.body).toHaveProperty("error");
  });

  it.each(blockedUsers)(
    `${label} rejects a %s account`,
    async (_status, token, expectedCode) => {
      const response = await send(token).expect(403);
      expect(response.body).toMatchObject({ code: expectedCode });
    },
  );

  it(`${label} admits an approved admin to the route handler`, async () => {
    const response = await send(ADMIN_TOKEN);
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});