/**
 * Integration tests for the per-IP rate limiter on
 * POST /api/inventory/estimate-dimensions/search.
 *
 * The OpenAI client is mocked so no live API key is required.
 * Each test uses a distinct fake IP via X-Forwarded-For to prevent cross-test
 * state bleed — the module-level estimateSearchHits Map accumulates across
 * tests in the same Jest worker because the module cache is shared.
 *
 * The database is NOT exercised by this endpoint; the pool is closed in
 * afterAll so Jest exits cleanly.
 */

// ── Mocks (hoisted before any import) ────────────────────────────────────────

const mockCreate = jest.fn();

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
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

jest.mock("../src/lib/poeBot", () => {
  const actual = jest.requireActual<typeof import("../src/lib/poeBot")>("../src/lib/poeBot");
  return {
    ...actual,
    tryPoeBotChain: jest.fn(async (_feature: unknown, fn: (client: unknown, model: string) => unknown) =>
      fn({ chat: { completions: { create: mockCreate } } }, "test-model"),
    ),
  };
});

jest.mock("../src/lib/aiProvider", () => ({
  getOpenAIFallbackClient: jest.fn(() => ({
    chat: { completions: { create: mockCreate } },
  })),
  getOpenAIModelForFeature: jest.fn(() => "test-model"),
  initProvider: jest.fn(),
  getProvider: jest.fn(() => "poe"),
  probePoeBotsOnStartup: jest.fn(),
  getProbeSummary: jest.fn(() => ({})),
  setProvider: jest.fn(),
  getAiClient: jest.fn(() => ({ chat: { completions: { create: mockCreate } } })),
  getEnrichModel: jest.fn(() => "test-model"),
  getIdentifyModel: jest.fn(() => "test-model"),
  getCatalogModel: jest.fn(() => "test-model"),
  getDimensionsModel: jest.fn(() => "test-model"),
  getReferenceModel: jest.fn(() => "test-model"),
  getModelForFeature: jest.fn(() => "test-model"),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import supertest from "supertest";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import app from "../src/app";

// ── Shared constants ──────────────────────────────────────────────────────────

const ENDPOINT = "/api/inventory/estimate-dimensions/search";

// Minimal valid base64 JPEG (1×1 white pixel) that satisfies the non-empty
// string check without triggering the 5 MB size guard.
const TINY_IMAGE =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";

// Must match the constant in inventory.ts.
const RATE_LIMIT = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * POST to the endpoint, spoofing the client IP via X-Forwarded-For.
 * The app has `trust proxy = 1` so Express peels one proxy hop and exposes
 * the forwarded address as req.ip.
 */
function hit(ip: string) {
  return supertest(app)
    .post(ENDPOINT)
    .set("X-Forwarded-For", ip)
    .send({ imageBase64: TINY_IMAGE });
}

// Per-run unique IP prefix: the rate limiter persists windows in the shared
// dev database, so re-using fixed IPs across concurrent or back-to-back runs
// (< 60s apart) would inherit another run's exhausted quota and 429 immediately.
// crypto.randomUUID() gives ~122 bits of entropy, making collisions negligible
// even across many parallel CI workers.
const RUN_TAG = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const uniqueIp = (host: number) =>
  `10.${parseInt(RUN_TAG.slice(0, 2), 16) % 256}.${parseInt(RUN_TAG.slice(2, 4), 16) % 256}.${host}`;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  // The endpoint sits behind requireAppAuth; authenticate every request as
  // the bootstrap admin (the clerk mock reads this env var when no Bearer
  // token is supplied).
  process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TEST_USER_ID;
});

afterAll(() => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default AI response: valid dimension JSON so the handler returns 200.
  mockCreate.mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            length: 50,
            width: 30,
            height: 20,
            diameter: null,
          }),
        },
      },
    ],
  });
});


// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/inventory/estimate-dimensions/search — rate limiter", () => {
  it("allows every request within the limit and returns 200 for each", async () => {
    const ip = uniqueIp(1);

    for (let i = 0; i < RATE_LIMIT; i++) {
      const res = await hit(ip);
      expect(res.status).toBe(200);
    }
  });

  it("blocks the (limit + 1)th request with 429 and a JSON error body", async () => {
    const ip = uniqueIp(2);

    for (let i = 0; i < RATE_LIMIT; i++) {
      await hit(ip);
    }

    const blocked = await hit(ip);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toHaveProperty("error");
    expect(blocked.body.error).toMatch(/rate limit/i);
  });

  it("does not count one IP's requests against a different IP's quota", async () => {
    const ipA = uniqueIp(3);
    const ipB = uniqueIp(4);

    // Exhaust the limit for IP-A.
    for (let i = 0; i < RATE_LIMIT; i++) {
      await hit(ipA);
    }

    // IP-A should now be blocked.
    const blockedA = await hit(ipA);
    expect(blockedA.status).toBe(429);

    // IP-B has a fresh, independent counter and must still be allowed.
    const allowedB = await hit(ipB);
    expect(allowedB.status).toBe(200);
  });
});
