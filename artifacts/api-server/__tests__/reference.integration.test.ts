/**
 * Integration tests for the reference routes:
 *  - POST /api/reference/ask (SSE streaming and JSON mode)
 *  - GET  /api/reference/quick-lookups
 *  - GET  /api/reference/quick-lookups/:label
 *  - POST /api/reference/quick-lookups/:label (AI fallback + DB write-back)
 *
 * The reference route answers questions via Gemini-2.5-Flash
 * (@workspace/integrations-gemini-ai → ai.models.generateContent), so that
 * call is mocked here — no live API key or network access is needed.
 *
 * The answer cache (answerCache) is mocked so the /ask tests are deterministic
 * and never touch the reference_answer_cache table. The quick-lookup tests use
 * the real test DB (quick_lookup_cache table must exist).
 */

// ── Mocks — must be declared before any imports so Jest can hoist them ─────────

const mockGenerateContent = jest.fn();
const mockGetCachedAnswer = jest.fn<Promise<string | null>, [string]>();
const mockSetCachedAnswer = jest.fn<Promise<void>, [string, string, string, (boolean | undefined)?]>();

jest.mock("@workspace/integrations-gemini-ai", () => {
  const mockAi = { models: { generateContent: mockGenerateContent } };
  return {
    ai: mockAi,
    getAiClient: () => mockAi,
    generateImage: jest.fn(),
    batchProcess: jest.fn(),
    batchProcessWithSSE: jest.fn(),
    isRateLimitError: jest.fn(() => false),
  };
});

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

jest.mock("../src/lib/answerCache", () => ({
  normalizeQuestion: (q: string): string => q.toLowerCase().trim().replace(/\s+/g, " "),
  hashQuestion: (normalized: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("crypto").createHash("sha256").update(normalized).digest("hex");
  },
  getCachedAnswer: mockGetCachedAnswer,
  setCachedAnswer: mockSetCachedAnswer,
  invalidateReferenceAnswerCache: jest.fn(),
}));

process.env.LOG_LEVEL = "silent";

import supertest from "supertest";
import app from "../src/app";
import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const TEST_LABEL = "JEST-REF-TEST-LABEL";

/**
 * Reconstruct the full answer text from an SSE response body by concatenating
 * every `data: {"content":"…"}` frame in order.
 */
function reconstructSseContent(body: string): string {
  const matches = [...body.matchAll(/data: (\{"content":.*?\})\n\n/g)];
  return matches
    .map((m) => (JSON.parse(m[1]!) as { content: string }).content)
    .join("");
}

async function ensureQuickLookupTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quick_lookup_cache (
      label TEXT PRIMARY KEY,
      answer TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function cleanupTestLabel() {
  try {
    await db.delete(quickLookupCacheTable).where(eq(quickLookupCacheTable.label, TEST_LABEL));
  } catch {
    // Table may not exist yet — ignore
  }
}

beforeAll(async () => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
  await ensureQuickLookupTable();
  await cleanupTestLabel();
});

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
  await cleanupTestLabel();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Cache miss by default so the AI path runs; individual tests override.
  mockGetCachedAnswer.mockResolvedValue(null);
  mockSetCachedAnswer.mockResolvedValue(undefined);
});

// ── POST /api/reference/ask ────────────────────────────────────────────────────

describe("POST /api/reference/ask", () => {
  it("returns 400 with JSON when question is missing", async () => {
    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({})
      .expect(400);
    expect(res.body).toHaveProperty("error");
  });

  it("error before headers: returns 500 JSON, never starts a stream", async () => {
    // getCachedAnswer runs before any SSE frame is written; a failure here
    // must surface as a clean 500 JSON response, not a partial stream.
    mockGetCachedAnswer.mockRejectedValueOnce(new Error("cache lookup blew up"));

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(500);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("error");
    expect(JSON.stringify(res.body)).not.toMatch(/cache lookup blew up/);
  });

  it("error after headers: emits a terminal event:error SSE frame", async () => {
    // Cache miss → headers flush → Gemini call fails mid-request, so the error
    // arrives after the SSE headers have been sent.
    mockGenerateContent.mockRejectedValueOnce(new Error("upstream gemini broke"));

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.text;
    expect(body).toContain("event: error");
    expect(body).toMatch(/data: \{"error":"[^"]+"\}/);
    expect(body).not.toMatch(/upstream gemini broke/);
  });

  it("happy path: streams content frames followed by done", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "**THWN-2** is a wire type." });

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(reconstructSseContent(res.text)).toBe("**THWN-2** is a wire type.");
    expect(res.text).toContain('data: {"done":true}');
    expect(res.text).not.toContain("event: error");
  });

  it("JSON mode (?stream=false): returns { answer } as a single JSON object", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "**THWN-2** is a wire type." });

    const res = await supertest(app)
      .post("/api/reference/ask?stream=false")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ answer: "**THWN-2** is a wire type." });
  });

  it("JSON mode (Accept: application/json): returns { answer } as a single JSON object", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "Answer text." });

    const res = await supertest(app)
      .post("/api/reference/ask")
      .set("Accept", "application/json")
      .send({ question: "what is AWG?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ answer: "Answer text." });
  });
});

// ── Admin-only knowledge scoping (POST /api/reference/ask) ─────────────────────

/** Read the systemInstruction sent to Gemini from the first generateContent call. */
function firstSystemInstruction(): string {
  const arg = mockGenerateContent.mock.calls[0]![0] as {
    config?: { systemInstruction?: string };
  };
  return arg.config?.systemInstruction ?? "";
}

describe("POST /api/reference/ask — admin knowledge scoping", () => {
  const NON_ADMIN_USER = "jest-nonadmin-user";

  beforeAll(async () => {
    // Seed an approved, non-admin user so requests authenticated as this user
    // pass requireAppAuth but resolve role='user'.
    await db.execute(sql`
      INSERT INTO users (clerk_user_id, email, status, role)
      VALUES (${NON_ADMIN_USER}, ${`${NON_ADMIN_USER}@test.example`}, 'approved', 'user')
      ON CONFLICT (clerk_user_id)
      DO UPDATE SET status = 'approved', role = 'user'
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE clerk_user_id = ${NON_ADMIN_USER}`);
  });

  it("admin request: system prompt INCLUDES admin-only knowledge", async () => {
    // Default auth user (jest-admin-user) is the bootstrap admin.
    mockGenerateContent.mockResolvedValueOnce({ text: "Answer." });

    await supertest(app)
      .post("/api/reference/ask?stream=false")
      .send({ question: "how do I import a CSV?" })
      .expect(200);

    const prompt = firstSystemInstruction();
    expect(prompt).toContain("Admin-only features");
    expect(prompt).toContain("CSV / spreadsheet import");
    expect(prompt).toContain("Catalog PDF upload");
    expect(prompt).toContain("AI enrichment");
    expect(prompt).toContain("Measure tab (admin only");
  });

  it("non-admin request: system prompt EXCLUDES admin-only knowledge", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "Answer." });

    await supertest(app)
      .post("/api/reference/ask?stream=false")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .send({ question: "how do I import a CSV?" })
      .expect(200);

    const prompt = firstSystemInstruction();
    // Shared, worker-facing knowledge is still present…
    expect(prompt).toContain("Search tab (everyone)");
    // …but nothing from the admin-only section leaks through.
    expect(prompt).not.toContain("Admin-only features");
    expect(prompt).not.toContain("CSV / spreadsheet import");
    expect(prompt).not.toContain("Catalog PDF upload");
    expect(prompt).not.toContain("AI enrichment");
    expect(prompt).not.toContain("Measure tab (admin only");
    expect(prompt).not.toContain("SQL console");
  });
});

// ── GET /api/reference/quick-lookups ──────────────────────────────────────────

describe("GET /api/reference/quick-lookups", () => {
  it("returns an array (may be empty)", async () => {
    const res = await supertest(app)
      .get("/api/reference/quick-lookups")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it("includes a row that was seeded", async () => {
    await db
      .insert(quickLookupCacheTable)
      .values({ label: TEST_LABEL, answer: "Test answer" })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer: "Test answer", updatedAt: new Date() },
      });

    const res = await supertest(app)
      .get("/api/reference/quick-lookups")
      .expect(200);

    const row = res.body.find((r: { label: string }) => r.label === TEST_LABEL);
    expect(row).toBeDefined();
    expect(row.answer).toBe("Test answer");
  });
});

// ── GET /api/reference/quick-lookups/:label ───────────────────────────────────

describe("GET /api/reference/quick-lookups/:label", () => {
  it("returns 404 for an unknown label", async () => {
    await supertest(app)
      .get("/api/reference/quick-lookups/JEST-NONEXISTENT-LABEL")
      .expect(404);
  });

  it("returns { answer } for an existing label", async () => {
    await db
      .insert(quickLookupCacheTable)
      .values({ label: TEST_LABEL, answer: "Stored answer" })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer: "Stored answer", updatedAt: new Date() },
      });

    const res = await supertest(app)
      .get(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .expect(200);

    expect(res.body).toEqual({ answer: "Stored answer" });
  });

  it("does NOT call the AI when the answer is already in the DB", async () => {
    await db
      .insert(quickLookupCacheTable)
      .values({ label: TEST_LABEL, answer: "Pre-seeded answer" })
      .onConflictDoUpdate({
        target: quickLookupCacheTable.label,
        set: { answer: "Pre-seeded answer", updatedAt: new Date() },
      });

    const res = await supertest(app)
      .get(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .expect(200);

    expect(res.body).toEqual({ answer: "Pre-seeded answer" });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("DB miss falls through to AI (POST); subsequent GET returns from DB without another AI call", async () => {
    await cleanupTestLabel();

    mockGenerateContent.mockResolvedValueOnce({ text: "Fresh AI answer." });

    // Layer 3: POST triggers AI and writes the answer to DB
    await supertest(app)
      .post(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .send({ question: "What is this?" })
      .expect(200);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // Layer 2: subsequent GET reads from DB — AI must NOT be called again
    const res = await supertest(app)
      .get(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .expect(200);

    expect(res.body).toEqual({ answer: "Fresh AI answer." });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1); // still exactly 1 — no second AI call
  });
});

// ── POST /api/reference/quick-lookups/:label ──────────────────────────────────

describe("POST /api/reference/quick-lookups/:label", () => {
  it("returns 400 when question is missing", async () => {
    const res = await supertest(app)
      .post(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .send({})
      .expect(400);
    expect(res.body).toHaveProperty("error");
  });

  it("calls AI, returns answer, and writes to DB cache", async () => {
    await cleanupTestLabel();

    mockGenerateContent.mockResolvedValueOnce({ text: "AI generated answer." });

    const res = await supertest(app)
      .post(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .send({ question: "What is this?" })
      .expect(200);

    expect(res.body).toEqual({ answer: "AI generated answer." });

    // Verify it was written to the DB
    const rows = await db
      .select()
      .from(quickLookupCacheTable)
      .where(eq(quickLookupCacheTable.label, TEST_LABEL));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("AI generated answer.");
  });

  it("upserts on second call (overwrites existing cache)", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "Updated answer." });

    const res = await supertest(app)
      .post(`/api/reference/quick-lookups/${TEST_LABEL}`)
      .send({ question: "What is this?" })
      .expect(200);

    expect(res.body).toEqual({ answer: "Updated answer." });

    const rows = await db
      .select()
      .from(quickLookupCacheTable)
      .where(eq(quickLookupCacheTable.label, TEST_LABEL));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("Updated answer.");
  });
});
