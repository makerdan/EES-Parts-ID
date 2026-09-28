/**
 * Regression coverage for POST /api/admin/restart.
 *
 * The route must be protected by the current approved-admin role boundary,
 * refuse production requests, and delegate accepted requests to the same
 * graceful shutdown coordinator as operating-system signals.
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
import {
  configureGracefulShutdown,
  requestGracefulShutdown,
  resetGracefulShutdownForTests,
} from "../src/lib/gracefulShutdown";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupTestUser,
  seedTestUser,
  workerQualifiedUserId,
} from "./helpers/testDb";

const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = workerQualifiedUserId("jest-restart-non-admin");
const DEMOTED_ADMIN_USER = workerQualifiedUserId("jest-restart-demoted-admin");
const PENDING_ADMIN_USER = workerQualifiedUserId("jest-restart-pending-admin");
const BANNED_ADMIN_USER = workerQualifiedUserId("jest-restart-banned-admin");

const originalNodeEnv = process.env.NODE_ENV;
let scheduleSpy: jest.SpyInstance;
let exitSpy: jest.Mock;
let closeListener: jest.Mock;
let drainBackgroundWork: jest.Mock;
let scheduledRestart: (() => void) | undefined;
let scheduledDelayMs: number | undefined;

beforeAll(async () => {
  await seedTestUser({ clerkUserId: NON_ADMIN_USER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: DEMOTED_ADMIN_USER, status: "approved", role: "admin" });
  await seedTestUser({ clerkUserId: PENDING_ADMIN_USER, status: "pending", role: "admin" });
  await seedTestUser({ clerkUserId: BANNED_ADMIN_USER, status: "banned", role: "admin" });
});

afterAll(async () => {
  await cleanupTestUser(NON_ADMIN_USER);
  await cleanupTestUser(DEMOTED_ADMIN_USER);
  await cleanupTestUser(PENDING_ADMIN_USER);
  await cleanupTestUser(BANNED_ADMIN_USER);
}, 15_000);

beforeEach(() => {
  process.env.NODE_ENV = "development";
  resetRestartStateForTests();
  resetGracefulShutdownForTests();
  exitSpy = jest.fn();
  closeListener = jest.fn((callback: () => void) => callback());
  drainBackgroundWork = jest.fn().mockResolvedValue(undefined);
  configureGracefulShutdown({
    server: { close: closeListener },
    shutdownBackgroundWork: drainBackgroundWork,
    exit: exitSpy,
  });
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
  scheduleSpy.mockRestore();
  resetRestartStateForTests();
  resetGracefulShutdownForTests();
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
    expect(drainBackgroundWork).not.toHaveBeenCalled();
  });

  it("rejects an approved non-admin without scheduling an exit", async () => {
    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(drainBackgroundWork).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", PENDING_ADMIN_USER],
    ["banned", BANNED_ADMIN_USER],
  ])("rejects a %s admin without scheduling shutdown", async (_status, userId) => {
    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${userId}`)
      .expect(403);

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(closeListener).not.toHaveBeenCalled();
    expect(drainBackgroundWork).not.toHaveBeenCalled();
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
    expect(drainBackgroundWork).not.toHaveBeenCalled();
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
    expect(drainBackgroundWork).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/restart — bounded development restart", () => {
  it("drains the listener and background work before final exit", async () => {
    let finishBackgroundWork!: () => void;
    drainBackgroundWork.mockReturnValueOnce(new Promise<void>((resolve) => {
      finishBackgroundWork = resolve;
    }));

    const res = await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(202);

    expect(res.body).toEqual({ restarting: true });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(scheduledDelayMs).toBe(200);
    expect(scheduledRestart).toBeDefined();

    scheduledRestart?.();
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(drainBackgroundWork).toHaveBeenCalledTimes(1);
    expect(drainBackgroundWork).toHaveBeenCalledWith(10_000);
    expect(exitSpy).not.toHaveBeenCalled();

    finishBackgroundWork();
    await Promise.resolve();
    await Promise.resolve();
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
    scheduledRestart?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(drainBackgroundWork).toHaveBeenCalledTimes(1);
  });

  it("admits an approved role-only admin without an MFA claim", async () => {
    await supertest(app)
      .post("/api/admin/restart")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(202);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
  });

  it("finalizes only once when cleanup settles after the hard limit", async () => {
    jest.useFakeTimers();
    let closeCallback!: () => void;
    let finishBackgroundWork!: () => void;
    const delayedClose = jest.fn((callback: () => void) => {
      closeCallback = callback;
    });
    const delayedBackgroundWork = jest.fn(() => new Promise<void>((resolve) => {
      finishBackgroundWork = resolve;
    }));
    configureGracefulShutdown({
      server: { close: delayedClose } as unknown as Parameters<
        typeof configureGracefulShutdown
      >[0]["server"],
      shutdownBackgroundWork: delayedBackgroundWork,
      exit: exitSpy,
      hardLimitMs: 50,
    });

    const shutdown = requestGracefulShutdown("admin-restart");
    jest.advanceTimersByTime(50);
    await shutdown;
    expect(exitSpy).toHaveBeenCalledTimes(1);

    closeCallback();
    finishBackgroundWork();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});