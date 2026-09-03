/**
 * Focused security and provider-boundary tests for POST /api/help/ask.
 *
 * The provider and answer cache are mocked so these tests inspect the exact
 * prompt/context sent by the route without network access or cache state.
 */

const mockCreate = jest.fn();
const mockGetCachedAnswer = jest.fn<Promise<string | null>, [string]>();
const mockSetCachedAnswer = jest.fn<Promise<void>, [string, string, string, (boolean | undefined)?]>();

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

jest.mock("../src/lib/aiProvider", () => ({
  getAiClient: () => ({ chat: { completions: { create: mockCreate } } }),
  getReferenceModel: () => "help-test-model",
}));

jest.mock("../src/lib/answerCache", () => ({
  normalizeQuestion: (question: string): string => question.toLowerCase().trim().replace(/\s+/g, " "),
  hashQuestion: (normalized: string): string => normalized,
  getCachedAnswer: mockGetCachedAnswer,
  setCachedAnswer: mockSetCachedAnswer,
}));

import supertest from "supertest";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import app from "../src/app";
import { HELP_ASSISTANT_LIMITS } from "../src/lib/helpAssistant";
import { cleanupTestUser, seedTestUser } from "./helpers/testDb";

const WORKER = "jest-help-assistant-worker";
const ADMIN = "jest-help-assistant-admin";

beforeAll(async () => {
  await seedTestUser({ clerkUserId: WORKER, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: ADMIN, status: "approved", role: "admin" });
});

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(WORKER),
    cleanupTestUser(ADMIN),
  ]);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCachedAnswer.mockResolvedValue(null);
  mockSetCachedAnswer.mockResolvedValue(undefined);
});

function auth(request: supertest.Test, token: string): supertest.Test {
  return request.set("Authorization", `Bearer ${token}`);
}

function providerRequest(): {
  model: string;
  max_completion_tokens: number;
  messages: Array<{ role: string; content: string }>;
} {
  return mockCreate.mock.calls[0]![0] as {
    model: string;
    max_completion_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
}

describe("POST /api/help/ask — grounded worker answers", () => {
  it("sends only selected general Help records and no external-source instructions", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Open **Search** and enter the part description." } }],
    });

    const res = await auth(supertest(app).post("/api/help/ask"), WORKER)
      .send({ question: "How do I find a part with Search?" })
      .expect(200);

    expect(res.body).toMatchObject({
      answer: "Open **Search** and enter the part description.",
      code: "HELP_ANSWER",
      cached: false,
    });
    const request = providerRequest();
    expect(request.model).toBe("help-test-model");
    expect(request.max_completion_tokens).toBe(HELP_ASSISTANT_LIMITS.maxCompletionTokens);
    const systemPrompt = request.messages[0]!.content;
    expect(systemPrompt).toContain("APPROVED HELP RECORDS");
    expect(systemPrompt).toContain("help.search.find-parts");
    expect(systemPrompt).not.toMatch(/web search|inventory context|electrical codes/i);
    expect(systemPrompt).not.toContain("help.admin.");
  });

  it("rejects unsupported questions before the provider can fabricate an answer", async () => {
    const res = await auth(supertest(app).post("/api/help/ask"), WORKER)
      .send({ question: "What is the NEC requirement for this circuit?" })
      .expect(422);

    expect(res.body).toEqual({
      error: "I couldn't find that in the approved Parts ID Help content. Please contact support.",
      code: "HELP_UNSUPPORTED",
      retryable: false,
      contactFallback: false,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("bounds the question and history contract", async () => {
    const tooManyTurns = Array.from(
      { length: HELP_ASSISTANT_LIMITS.maxHistoryItems + 1 },
      () => ({ q: "Search", a: "Use Search." }),
    );
    const res = await auth(supertest(app).post("/api/help/ask"), WORKER)
      .send({ question: "How do I find a part?", history: tooManyTurns })
      .expect(400);

    expect(res.body.code).toBe("HELP_INVALID_REQUEST");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does not cache history-dependent answers", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Use the Search tab." } }],
    });

    await auth(supertest(app).post("/api/help/ask"), WORKER)
      .send({
        question: "Where do I find a part?",
        history: [{ q: "What is Search?", a: "It finds parts." }],
      })
      .expect(200);

    expect(mockGetCachedAnswer).not.toHaveBeenCalled();
    expect(mockSetCachedAnswer).not.toHaveBeenCalled();
    expect(providerRequest().messages).toHaveLength(4);
  });
});

describe("POST /api/help/ask — privileged context boundary", () => {
  it("includes admin records only for a current admin with MFA", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Open the spreadsheet import tool in Admin." } }],
    });

    await auth(supertest(app).post("/api/help/ask"), ADMIN)
      .send({ question: "How do I import inventory from a spreadsheet?" })
      .expect(200);

    const systemPrompt = providerRequest().messages[0]!.content;
    expect(systemPrompt).toContain("help.admin.inventory-import");
    expect(systemPrompt).toContain("current administrator access verified");
  });

  it("excludes admin records when the database role is no longer admin", async () => {
    await db
      .update(usersTable)
      .set({ role: "user" })
      .where(eq(usersTable.clerkUserId, ADMIN));

    const res = await auth(supertest(app).post("/api/help/ask"), ADMIN)
      .send({ question: "How do I import inventory from a spreadsheet?" })
      .expect(422);

    expect(res.body.code).toBe("HELP_UNSUPPORTED");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("keeps provider failures actionable without exposing provider details", async () => {
    mockCreate.mockRejectedValueOnce(new Error("provider secret and hidden prompt"));

    const res = await auth(supertest(app).post("/api/help/ask"), WORKER)
      .send({ question: "How do I find a part with Search?" })
      .expect(503);

    expect(res.body).toMatchObject({
      code: "HELP_PROVIDER_UNAVAILABLE",
      retryable: true,
      contactFallback: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("provider secret");
    expect(JSON.stringify(res.body)).not.toContain("hidden prompt");
  });
});
