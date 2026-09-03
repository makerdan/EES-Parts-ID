/**
 * Regression coverage for POST /api/admin/restart.
 *
 * The route must be protected by the existing app/admin/MFA middleware, must
 * refuse production requests, and must never terminate the Jest worker. The
 * route-local restartRuntime seam is stubbed below so the delayed exit can be
 * tested with fake timers.
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
import {
  resetRestartStateForTests,
  restartRuntime,
} from "../src/routes/admin";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { cleanupTestUser, seedTestUser } from "./helpers/testDb";

const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = "jest-restart-non-admin";
const DEMOTED_ADMIN_USER = "jest-restart-demoted-admin";

const originalNodeEnv = process.env.NODE_ENV;
let exitSpy: jest.SpyInstance;
let scheduleSpy: jest.SpyInstance;
let scheduledRestart: (() => void) | undefined;
let scheduledDelayMs: number | undefined;

beforeAll(async () => {
  await seedTestUser({ clerkUserId: NON_ADMIN_USER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: DEMOTED_ADMIN_USER, status: "approved", role: "admin" });
});

afterAll(async () => {
  await cleanupTestUser(NON_ADMIN_USER);
  await cleanupTestUser(DEMOTED_ADMIN_USER);
}, 15_000);

beforeEach(() => {
  process.env.NODE_ENV = "development";
  resetRestartStateForTests();
  exitSpy = jest.spyOn(restartRuntime, "exit").mockImplementation(() => undefined);
  scheduledRestart = undefined;
  scheduledDelayMs = undefined;
  scheduleSpy = jest.spyOn(restartRuntime, "schedule").mockImplementation((callback, delayMs) => {
    scheduledRestart = callback;
    scheduledDelayMs = delayMs;
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  exitSpy.mockRestore();
  scheduleSpy.mockRestore();
  resetRestartStateForTests();
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("POST /api/admin/restart — authorization and environment gates", () => {
  it("rejects an anonymous caller without scheduling an exit", async () => {
    await supertest(app)
      .post("/api/admin/restart")
      .expect(401);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects an approved non-admin without scheduling an exit", async () => {
    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects a demoted admin identity at the current database role boundary", async () => {
    await seedTestUser({
      clerkUserId: DEMOTED_ADMIN_USER,
      status: "approved",
      role: "user",
    });

    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${DEMOTED_ADMIN_USER}`)
      .expect(403);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("rejects an authorized caller in production without exposing operational details", async () => {
    process.env.NODE_ENV = "production";

    const res = await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(503);

    expect(res.body).toEqual({
      restarting: false,
      code: "RESTART_UNAVAILABLE",
      error: "API restart is unavailable",
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/restart — bounded development restart", () => {
  it("returns the accepted contract and exits only after the delayed handoff", async () => {
    const res = await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(202);

    expect(res.body).toEqual({ restarting: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(scheduledDelayMs).toBe(200);
    expect(scheduledRestart).toBeDefined();

    scheduledRestart?.();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rejects repeated requests while the first restart is still pending", async () => {
    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(202);

    const repeated = await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(409);

    expect(repeated.body).toEqual({
      restarting: false,
      code: "RESTART_IN_PROGRESS",
      error: "API restart is already in progress",
    });
    expect(exitSpy).not.toHaveBeenCalled();

    scheduledRestart?.();
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});