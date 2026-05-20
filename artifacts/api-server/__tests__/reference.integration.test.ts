/**
 * Integration tests for the reference routes:
 *  - POST /api/reference/ask (SSE streaming and JSON mode)
 *  - GET  /api/reference/quick-lookups
 *  - GET  /api/reference/quick-lookups/:label
 *  - POST /api/reference/quick-lookups/:label (AI fallback + DB write-back)
 *
 * The OpenAI client is mocked so no live API key or network access is needed.
 * The database is the real test DB (quick_lookup_cache table must exist).
 */

const mockCreate = jest.fn();

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: mockCreate } },
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

process.env.LOG_LEVEL = "silent";

import supertest from "supertest";
import app from "../src/app";
import { closePool } from "./helpers/testDb";
import { db } from "@workspace/db";
import { quickLookupCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const TEST_LABEL = "JEST-REF-TEST-LABEL";

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
  await ensureQuickLookupTable();
  await cleanupTestLabel();
});

afterAll(async () => {
  await cleanupTestLabel();
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
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
    mockCreate.mockRejectedValueOnce(new Error("upstream auth blew up"));

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(500);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("error");
    expect(JSON.stringify(res.body)).not.toMatch(/upstream auth blew up/);
  });

  it("error after headers: emits a terminal event:error SSE frame", async () => {
    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() {
            if (i === 0) {
              i++;
              return {
                value: { choices: [{ delta: { content: "Hello" } }] },
                done: false,
              };
            }
            throw new Error("upstream stream broke mid-flight");
          },
        };
      },
    });

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.text;
    expect(body).toContain('data: {"content":"Hello"}');
    expect(body).toContain("event: error");
    expect(body).toMatch(/data: \{"error":"[^"]+"\}/);
    expect(body).not.toMatch(/upstream stream broke mid-flight/);
  });

  it("happy path: streams content frames followed by done", async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "**THWN-2** is " } }] };
        yield { choices: [{ delta: { content: "a wire type." } }] };
      },
    });

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain('data: {"content":"**THWN-2** is "}');
    expect(res.text).toContain('data: {"content":"a wire type."}');
    expect(res.text).toContain('data: {"done":true}');
    expect(res.text).not.toContain("event: error");
  });

  it("JSON mode (?stream=false): returns { answer } as a single JSON object", async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "**THWN-2** is " } }] };
        yield { choices: [{ delta: { content: "a wire type." } }] };
      },
    });

    const res = await supertest(app)
      .post("/api/reference/ask?stream=false")
      .send({ question: "what is THWN-2?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ answer: "**THWN-2** is a wire type." });
  });

  it("JSON mode (Accept: application/json): returns { answer } as a single JSON object", async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "Answer text." } }] };
      },
    });

    const res = await supertest(app)
      .post("/api/reference/ask")
      .set("Accept", "application/json")
      .send({ question: "what is AWG?" })
      .expect(200);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ answer: "Answer text." });
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

    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "AI generated answer." } }] };
      },
    });

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
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "Updated answer." } }] };
      },
    });

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
