/**
 * Integration tests for POST /api/reference/ask (SSE streaming Q&A).
 *
 * The OpenAI client is mocked so no live API key or network access is needed.
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

// Quiet logger output during the after-headers test.
process.env.LOG_LEVEL = "silent";

import supertest from "supertest";
import app from "../src/app";
import { closePool } from "./helpers/testDb";

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/reference/ask", () => {
  it("returns 400 with JSON when question is missing", async () => {
    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({})
      .expect(400);
    expect(res.body).toHaveProperty("error");
  });

  it("error before headers: returns 500 JSON, never starts a stream", async () => {
    // openai.create rejects synchronously — happens before any res.write.
    mockCreate.mockRejectedValueOnce(new Error("upstream auth blew up"));

    const res = await supertest(app)
      .post("/api/reference/ask")
      .send({ question: "what is THWN-2?" })
      .expect(500);

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toHaveProperty("error");
    // Never leak raw upstream error text.
    expect(JSON.stringify(res.body)).not.toMatch(/upstream auth blew up/);
  });

  it("error after headers: emits a terminal event:error SSE frame", async () => {
    // Async iterator that yields one chunk and then throws.
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

    // SSE content type means stream started.
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    const body = res.text;
    expect(body).toContain('data: {"content":"Hello"}');
    expect(body).toContain("event: error");
    expect(body).toMatch(/data: \{"error":"[^"]+"\}/);
    // Raw upstream error text must not be exposed.
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
});
