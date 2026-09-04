/**
 * Contract and authorization tests for the structured Help API.
 *
 * The corpus is static and server-owned. These tests still exercise the real
 * app-auth and admin-MFA middleware through the Express app so a client cannot
 * select the admin audience by changing a query parameter or role hint.
 */

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

import supertest from "supertest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import app from "../src/app";
import {
  ALL_HELP_RECORDS,
  getHelpResponse,
  HELP_CONTENT_VERSION,
  HELP_LIMITS,
  HELP_SCHEMA_VERSION,
  validateHelpRecords,
} from "../src/lib/helpContent";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupTestUser,
  seedTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";

const APPROVED_USER = workerQualifiedUserId("jest-help-approved-user");
const PENDING_USER = workerQualifiedUserId("jest-help-pending-user");
const BANNED_USER = workerQualifiedUserId("jest-help-banned-user");
const STALE_ADMIN_USER = workerQualifiedUserId("jest-help-stale-admin-user");

beforeAll(async () => {
  await seedTestUser({ clerkUserId: APPROVED_USER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: PENDING_USER, status: "pending", role: "user" });
  await seedTestUser({ clerkUserId: BANNED_USER, status: "banned", role: "user" });
  await seedTestUser({ clerkUserId: STALE_ADMIN_USER, status: "approved", role: "admin" });
});

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(APPROVED_USER),
    cleanupTestUser(PENDING_USER),
    cleanupTestUser(BANNED_USER),
    cleanupTestUser(STALE_ADMIN_USER),
  ]);
});

function auth(request: supertest.Test, token: string): supertest.Test {
  return request.set("Authorization", `Bearer ${token}`);
}

describe("Help content contract", () => {
  it("contains bounded, versioned, deterministic records for both audiences", () => {
    validateHelpRecords(ALL_HELP_RECORDS);

    const general = getHelpResponse("general");
    const admin = getHelpResponse("admin");

    expect(general.schemaVersion).toBe(HELP_SCHEMA_VERSION);
    expect(general.contentVersion).toBe(HELP_CONTENT_VERSION);
    expect(general.audience).toBe("general");
    expect(admin.audience).toBe("admin");
    expect(general.records.every((record) => record.audience === "general")).toBe(true);
    expect(admin.records.every((record) => record.audience === "admin")).toBe(true);
    expect(general.records.map((record) => record.id)).toEqual(
      [...general.records].map((record) => record.id).sort(),
    );
    expect(admin.records.map((record) => record.id)).not.toEqual(
      expect.arrayContaining(general.records.map((record) => record.id)),
    );
    expect([...general.records, ...admin.records].every((record) => JSON.stringify(record).length <= HELP_LIMITS.maxRecordBytes)).toBe(true);
  });

  it("keeps the general response isolated after the admin response is cached", () => {
    getHelpResponse("admin");
    const general = getHelpResponse("general");
    const serialized = JSON.stringify(general);

    expect(serialized).not.toContain("admin-only");
    expect(serialized).not.toContain("spreadsheet import");
    expect(serialized).not.toContain("zone editor");
  });
});

describe("GET /api/help", () => {
  it("rejects anonymous callers", async () => {
    const res = await supertest(app).get("/api/help").expect(401);
    expect(res.body).toEqual({ error: "Authentication required" });
    expect(JSON.stringify(res.body)).not.toMatch(/admin|catalog|zone/i);
  });

  it("rejects pending and banned callers without restricted metadata", async () => {
    const pending = await auth(supertest(app).get("/api/help"), PENDING_USER).expect(403);
    const banned = await auth(supertest(app).get("/api/help"), BANNED_USER).expect(403);

    for (const response of [pending, banned]) {
      expect(JSON.stringify(response.body)).not.toMatch(/admin|catalog|zone|spreadsheet/i);
    }
  });

  it("returns only structured general records for an approved worker", async () => {
    const res = await auth(supertest(app).get("/api/help"), APPROVED_USER).expect(200);

    expect(res.body.schemaVersion).toBe(HELP_SCHEMA_VERSION);
    expect(res.body.contentVersion).toBe(HELP_CONTENT_VERSION);
    expect(res.body.audience).toBe("general");
    expect(res.body.records.length).toBeGreaterThan(0);
    expect(res.body.records.every((record: { audience: string }) => record.audience === "general")).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/admin-only|spreadsheet import|zone editor|LiDAR/i);
  });

  it("does not let a query parameter select the admin audience", async () => {
    const res = await auth(supertest(app).get("/api/help?audience=admin"), APPROVED_USER).expect(400);
    expect(res.body).toEqual({ error: "Invalid Help request" });
    expect(JSON.stringify(res.body)).not.toMatch(/admin-only|spreadsheet|zone/i);
  });

  it("rejects malformed workflow queries without revealing corpus metadata", async () => {
    const res = await auth(supertest(app).get("/api/help?workflow=NOT_VALID!"), APPROVED_USER).expect(400);
    expect(res.body).toEqual({ error: "Invalid Help request" });
    expect(JSON.stringify(res.body)).not.toMatch(/admin|catalog|zone/i);
  });
});

describe("GET /api/help/admin", () => {
  it("returns admin records only after current role and MFA checks", async () => {
    const res = await auth(supertest(app).get("/api/help/admin"), ADMIN_TEST_USER_ID).expect(200);

    expect(res.body.schemaVersion).toBe(HELP_SCHEMA_VERSION);
    expect(res.body.contentVersion).toBe(HELP_CONTENT_VERSION);
    expect(res.body.audience).toBe("admin");
    expect(res.body.records.every((record: { audience: string }) => record.audience === "admin")).toBe(true);
    expect(JSON.stringify(res.body)).toMatch(/spreadsheet import|zone editor|LiDAR/i);
  });

  it("rejects an approved non-admin without exposing admin content", async () => {
    const res = await auth(supertest(app).get("/api/help/admin"), APPROVED_USER).expect(403);
    expect(JSON.stringify(res.body)).not.toMatch(/admin-only|spreadsheet|zone|LiDAR/i);
  });

  it("rejects a stale admin role from the current database row", async () => {
    await db
      .update(usersTable)
      .set({ role: "user" })
      .where(eq(usersTable.clerkUserId, STALE_ADMIN_USER));

    const res = await auth(supertest(app).get("/api/help/admin"), STALE_ADMIN_USER).expect(403);
    expect(JSON.stringify(res.body)).not.toMatch(/admin-only|spreadsheet|zone|LiDAR/i);
  });

  it("supports a single bounded workflow without changing the audience", async () => {
    const res = await auth(
      supertest(app).get("/api/help/admin?workflow=admin-inbox"),
      ADMIN_TEST_USER_ID,
    ).expect(200);

    expect(res.body.audience).toBe("admin");
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].id).toBe("help.admin.inbox");
  });
});

describe("Reference namespace compatibility", () => {
  it("uses the same audience-filtered contract under /reference/help", async () => {
    const res = await auth(supertest(app).get("/api/reference/help"), APPROVED_USER).expect(200);
    expect(res.body.audience).toBe("general");
    expect(res.body.records.every((record: { audience: string }) => record.audience === "general")).toBe(true);
  });
});