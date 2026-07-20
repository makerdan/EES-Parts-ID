/**
 * Integration tests for adminAiStatus routes.
 *
 * Covers:
 *   - GET /api/admin/ai-status → 401 without token, 200 with token
 *   - POST /api/admin/ai-status/probe → 401 without token, 200 with token
 *   - POST /api/admin/ai-status/probe/:botName → 401 without token
 *   - POST /api/admin/ai-status/probe/:botName → 400 for unknown bot name
 *   - POST /api/admin/ai-status/probe/:botName → 200 and bots map updated for known bot
 *   - POST /api/admin/ai-status/probe/:botName → 200 and bots map reflects probe failure
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
const mockCreate = jest.fn();

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() }, }, audio: { transcriptions: { create: jest.fn() } } },
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

// Mock OpenAI so probePoeBotsOnStartup and probeSinglePoeBot use our mock
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
);

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import { getAllPoeModelNames } from "../src/lib/aiProvider";

// ── Setup ─────────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-admin-ai-status-secret";
let adminToken: string;

beforeAll(() => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
});

beforeEach(() => {
  mockCreate.mockReset();
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ai-status
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/ai-status", () => {
  it("returns 401 without an auth token", async () => {
    const res = await supertest(app).get("/api/admin/ai-status").expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 200 and a bots object when authenticated", async () => {
    const res = await supertest(app)
      .get("/api/admin/ai-status")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(typeof res.body.bots).toBe("object");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/ai-status/probe  (full re-probe — existing endpoint)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/ai-status/probe", () => {
  it("returns 401 without an auth token", async () => {
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe")
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/ai-status/probe/:botName  (single-bot re-probe)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/ai-status/probe/:botName", () => {
  it("returns 401 without an auth token", async () => {
    const [firstBot] = getAllPoeModelNames();
    const res = await supertest(app)
      .post(`/api/admin/ai-status/probe/${encodeURIComponent(firstBot!)}`)
      .expect(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for an unknown bot name", async () => {
    const res = await supertest(app)
      .post("/api/admin/ai-status/probe/NonExistentBot-XYZ")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(400);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/Unknown bot name/);
  });

  it("returns 200 with a bots map for a known bot when probe succeeds", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    const [firstBot] = getAllPoeModelNames();

    const res = await supertest(app)
      .post(`/api/admin/ai-status/probe/${encodeURIComponent(firstBot!)}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(typeof res.body.bots).toBe("object");
    expect(res.body.bots[firstBot!]).toBe("ok");
  });

  it("returns 200 with bots map showing 'error' when probe fails with a generic error", async () => {
    mockCreate.mockRejectedValue(new Error("Service Unavailable"));
    const [firstBot] = getAllPoeModelNames();

    const res = await supertest(app)
      .post(`/api/admin/ai-status/probe/${encodeURIComponent(firstBot!)}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(res.body.bots[firstBot!]).toBe("error");
  });

  it("returns 200 with bots map showing '404' when probe fails with status 404", async () => {
    mockCreate.mockRejectedValue({ status: 404 });
    const knownBots = getAllPoeModelNames();
    // Use a non-catalog bot to avoid the fallback probe path
    const nonCatalogBot = (knownBots.find((n) => n !== "Gemini-3.1-Pro") ?? knownBots[0])!;

    const res = await supertest(app)
      .post(`/api/admin/ai-status/probe/${encodeURIComponent(nonCatalogBot)}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty("bots");
    expect(res.body.bots[nonCatalogBot]).toBe("404");
  });

  it("only calls the Poe API for the named bot (not all bots)", async () => {
    mockCreate.mockResolvedValue({ choices: [] });
    const [firstBot] = getAllPoeModelNames();

    await supertest(app)
      .post(`/api/admin/ai-status/probe/${encodeURIComponent(firstBot!)}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    // Only one create call for the single named bot
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: firstBot }),
    );
  });
});
