/**
 * Integration tests for the admin AI-provider control.
 *
 * The app and aiProvider module are loaded after the hermetic environment and
 * OpenAI constructor mock are installed. This keeps the test on the real
 * Express route and database while ensuring no provider API request can escape.
 *
 * Covers:
 *   - GET /api/admin/ai-provider with an admin credential
 *   - POST /api/admin/ai-provider switching runtime and persisted state
 *   - A later GET proving the switch survives the request boundary
 *   - Invalid, unavailable, unauthenticated, and non-admin transitions
 */

// ── Hermetic provider configuration ────────────────────────────────────────────
const originalEnv = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  POE_API_KEY2: process.env.POE_API_KEY2,
  AI_INTEGRATIONS_OPENAI_BASE_URL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  AI_INTEGRATIONS_OPENAI_API_KEY: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  SKIP_ADMIN_MFA: process.env.SKIP_ADMIN_MFA,
};

process.env.AI_PROVIDER = "poe";
process.env.POE_API_KEY2 = "test-poe-key";
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://test.openai.example/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-openai-key";
process.env.SKIP_ADMIN_MFA = "true";

// ── Provider boundary mock ──────────────────────────────────────────────────────
const mockCompletionsCreate = jest.fn();
const mockOpenAIConstructor = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCompletionsCreate } },
}));

jest.mock("openai", () => mockOpenAIConstructor);

// Routes import the workspace AI integration transitively. Keep those imports
// inert as well; the admin provider route itself only needs the OpenAI boundary.
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

// ── Imports ─────────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { db, adminPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Express } from "express";

import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import { cleanupTestUser, seedTestUser } from "./helpers/testDb";
import type * as AiProviderModule from "../src/lib/aiProvider";

// ── Test state ──────────────────────────────────────────────────────────────────
const NON_ADMIN_USER_ID = "jest-ai-provider-nonadmin";
const adminToken = ADMIN_TEST_USER_ID;

let app: Express;
let aiProvider: typeof AiProviderModule;
let originalPreference: typeof adminPreferencesTable.$inferSelect | undefined;

async function persistProvider(provider: "poe" | "openai"): Promise<void> {
  await db
    .insert(adminPreferencesTable)
    .values({ id: 1, aiProvider: provider, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: adminPreferencesTable.id,
      set: { aiProvider: provider, updatedAt: new Date() },
    });
}

async function readPersistedProvider(): Promise<string | null> {
  const rows = await db
    .select({ aiProvider: adminPreferencesTable.aiProvider })
    .from(adminPreferencesTable)
    .where(eq(adminPreferencesTable.id, 1))
    .limit(1);

  return rows[0]?.aiProvider ?? null;
}

beforeAll(async () => {
  // Load the app only after process.env has been made hermetic. The provider
  // module reads AI_PROVIDER during module initialization.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ default: app } = require("../src/app") as { default: Express });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  aiProvider = require("../src/lib/aiProvider") as typeof AiProviderModule;

  const rows = await db
    .select()
    .from(adminPreferencesTable)
    .where(eq(adminPreferencesTable.id, 1))
    .limit(1);
  originalPreference = rows[0];

  await seedTestUser({
    clerkUserId: NON_ADMIN_USER_ID,
    status: "approved",
    role: "user",
  });
});

beforeEach(async () => {
  aiProvider.setProvider("poe");
  await persistProvider("poe");
});

afterAll(async () => {
  await cleanupTestUser(NON_ADMIN_USER_ID);

  if (originalPreference) {
    await db
      .update(adminPreferencesTable)
      .set({
        aiProvider: originalPreference.aiProvider,
        updatedAt: originalPreference.updatedAt,
      })
      .where(eq(adminPreferencesTable.id, 1));
  } else {
    await db
      .delete(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1));
  }

  const originalProvider =
    originalEnv.AI_PROVIDER?.toLowerCase() === "openai" ? "openai" : "poe";
  aiProvider.setProvider(originalProvider);

  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 20_000);

// ─────────────────────────────────────────────────────────────────────────────
// Full read → switch → persist → read round trip
// ─────────────────────────────────────────────────────────────────────────────

describe("Admin AI-provider switch", () => {
  it("reads the active provider, switches it, persists it, and returns it later", async () => {
    const initial = await supertest(app)
      .get("/api/admin/ai-provider")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(initial.body).toEqual({ provider: "poe" });

    const switched = await supertest(app)
      .post("/api/admin/ai-provider")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ provider: "openai" })
      .expect(200);

    expect(switched.body).toEqual({ provider: "openai", persisted: true });
    expect(aiProvider.getProvider()).toBe("openai");
    expect(await readPersistedProvider()).toBe("openai");

    const laterRead = await supertest(app)
      .get("/api/admin/ai-provider")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);

    expect(laterRead.body).toEqual({ provider: "openai" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejected transitions do not alter runtime or persisted state
// ─────────────────────────────────────────────────────────────────────────────

describe("Admin AI-provider rejected transitions", () => {
  it("rejects an invalid provider without changing runtime or persisted state", async () => {
    const res = await supertest(app)
      .post("/api/admin/ai-provider")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ provider: "anthropic" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(aiProvider.getProvider()).toBe("poe");
    expect(await readPersistedProvider()).toBe("poe");
  });

  it("returns 503 for an unavailable provider without changing state", async () => {
    aiProvider.setProvider("openai");
    await persistProvider("openai");

    const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    try {
      const res = await supertest(app)
        .post("/api/admin/ai-provider")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ provider: "openai" })
        .expect(503);

      expect(res.body.error).toMatch(/AI_INTEGRATIONS_OPENAI_API_KEY/);
      expect(aiProvider.getProvider()).toBe("openai");
      expect(await readPersistedProvider()).toBe("openai");
    } finally {
      if (savedKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
    }
  });

  it("rejects an unauthenticated caller without changing state", async () => {
    aiProvider.setProvider("openai");
    await persistProvider("openai");

    await supertest(app)
      .post("/api/admin/ai-provider")
      .send({ provider: "poe" })
      .expect(401);

    expect(aiProvider.getProvider()).toBe("openai");
    expect(await readPersistedProvider()).toBe("openai");
  });

  it("rejects an approved non-admin without changing state", async () => {
    aiProvider.setProvider("openai");
    await persistProvider("openai");

    await supertest(app)
      .post("/api/admin/ai-provider")
      .set("Authorization", `Bearer ${NON_ADMIN_USER_ID}`)
      .send({ provider: "poe" })
      .expect(403);

    expect(aiProvider.getProvider()).toBe("openai");
    expect(await readPersistedProvider()).toBe("openai");
  });
});