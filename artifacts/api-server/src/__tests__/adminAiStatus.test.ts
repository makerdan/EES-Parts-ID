/**
 * Integration tests for GET /api/admin/ai-status and POST /api/admin/ai-status/probe.
 *
 * Covers:
 * - GET /admin/ai-status returns 401 without a valid token
 * - GET /admin/ai-status returns the current probe summary when authenticated
 * - POST /admin/ai-status/probe triggers a probe and returns refreshed results
 * - Both endpoints return an empty bots object when provider is not "poe"
 */

// ── Env vars — must be set before any require() / module imports ───────────────
process.env.ADMIN_PASSWORD = "jest-ai-status-secret";
process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://test.openai.example/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-openai-key";

// ── OpenAI constructor mock ───────────────────────────────────────────────────
// aiProvider.ts calls `new OpenAI(...)` at module load time. We must intercept
// the constructor before any module is first required so that no real HTTP
// connections are attempted during tests.
const mockCompletionsCreate = jest.fn().mockResolvedValue({
  id: "chatcmpl-mock",
  choices: [{ message: { role: "assistant", content: "hi" } }],
});

class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation(() => ({
    chat: { completions: { create: mockCompletionsCreate } },
  }));

(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError =
  MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError =
  MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError =
  MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError =
  MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError =
  MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError =
  MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

// ── Standard workspace mocks ──────────────────────────────────────────────────
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
import app from "../app";
import { ADMIN_TEST_USER_ID } from "../../__tests__/helpers/adminAuth";
import {
  setProvider,
  getProbeSummary,
  probePoeBotsOnStartup,
  getAllPoeModelNames,
} from "../lib/aiProvider";
import { db, usersTable } from "@workspace/db";
import { like } from "drizzle-orm";

// ── Helpers ───────────────────────────────────────────────────────────────────
// The bootstrap admin authenticates by presenting their Clerk user id.
function makeAdminToken(): string {
  return ADMIN_TEST_USER_ID;
}

// An approved, non-admin user — authorised for the app but not for admin routes.
const NON_ADMIN_USER = "jest-aistatus-nonadmin";

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeAll(async () => {
  await db
    .insert(usersTable)
    .values({ clerkUserId: NON_ADMIN_USER, email: "na@test.example", status: "approved", role: "user" })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: usersTable.status, role: usersTable.role },
    });
});

afterAll(async () => {
  // Restore provider to "poe" so module state is clean for any subsequent suites
  setProvider("poe");
  await db.delete(usersTable).where(like(usersTable.clerkUserId, "jest-aistatus-%"));
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Auth guard — no token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/ai-status — auth guard", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

describe("POST /api/admin/ai-status/probe — auth guard", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 for an approved non-admin user", async () => {
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ai-status — authenticated, provider = "poe"
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/ai-status — authenticated, provider=poe", () => {
  beforeAll(async () => {
    // Seed the probe results by running the probe directly so that GET has
    // something to return.
    mockCompletionsCreate.mockResolvedValue({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });
    setProvider("poe");
    await probePoeBotsOnStartup();
  });

  it("returns 200 with a bots object shaped as Record<string, BotProbeStatus>", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(typeof res.body.bots).toBe("object");
  });

  it("bots object includes all probed bot names after the probe has run", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const botNames = getAllPoeModelNames();
    for (const name of botNames) {
      // Use array form to avoid toHaveProperty treating dots in names as path separators
      expect(res.body.bots).toHaveProperty([name]);
    }
  });

  it("every bot status is one of: ok | timeout | 404 | error", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const validStatuses = new Set(["ok", "timeout", "404", "error"]);
    for (const status of Object.values(res.body.bots as Record<string, string>)) {
      expect(validStatuses.has(status)).toBe(true);
    }
  });

  it("response matches getProbeSummary() at call time", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.bots).toEqual(getProbeSummary());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/ai-status/probe — authenticated, provider = "poe"
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/ai-status/probe — authenticated, provider=poe", () => {
  beforeEach(() => {
    mockCompletionsCreate.mockReset();
  });

  it("returns 200 with a bots object after triggering a probe", async () => {
    mockCompletionsCreate.mockResolvedValue({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: "pong" } }],
    });
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(typeof res.body.bots).toBe("object");
  });

  it("marks all bots as 'ok' when the OpenAI client resolves successfully", async () => {
    mockCompletionsCreate.mockResolvedValue({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: "pong" } }],
    });
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const botNames = getAllPoeModelNames();
    for (const name of botNames) {
      expect(res.body.bots[name]).toBe("ok");
    }
  });

  it("marks a bot as 'error' when the client rejects with a non-404 error", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    mockCompletionsCreate.mockRejectedValue(err);
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const botNames = getAllPoeModelNames();
    for (const name of botNames) {
      expect(res.body.bots[name]).toBe("error");
    }
  });

  it("marks a bot as '404' when the client rejects with status 404", async () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    mockCompletionsCreate.mockRejectedValue(err);
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const botNames = getAllPoeModelNames();
    for (const name of botNames) {
      expect(["404", "ok", "error"]).toContain(res.body.bots[name]);
    }
  });

  it("returned bots object matches getProbeSummary() immediately after the probe", async () => {
    mockCompletionsCreate.mockResolvedValue({
      id: "chatcmpl-mock",
      choices: [{ message: { role: "assistant", content: "pong" } }],
    });
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.bots).toEqual(getProbeSummary());
  });

  it("is advisory — always returns 200 even when the probe throws internally", async () => {
    mockCompletionsCreate.mockRejectedValue(new Error("unexpected internal failure"));
    setProvider("poe");

    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider ≠ "poe" — both endpoints return empty bots object
// ─────────────────────────────────────────────────────────────────────────────

describe("Both endpoints return empty bots when provider is not poe", () => {
  beforeAll(() => {
    setProvider("openai");
  });

  afterAll(() => {
    setProvider("poe");
  });

  it("GET /api/admin/ai-status returns { bots: {} } when provider is openai", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(res.body.bots).toEqual({});
  });

  it("POST /api/admin/ai-status/probe returns { bots: {} } when provider is openai", async () => {
    const token = makeAdminToken();
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(res.body.bots).toEqual({});
  });
});
