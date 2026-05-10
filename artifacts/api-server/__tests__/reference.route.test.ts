/**
 * Tests for POST /api/reference/ask — JSON mode (stream=false).
 *
 * The route supports two response modes:
 *   - SSE streaming (default): Content-Type: text/event-stream
 *   - JSON (non-streaming): triggered by ?stream=false or Accept: application/json
 *
 * iOS React Native does not expose ReadableStream on fetch response bodies, so
 * the mobile client always uses JSON mode. A regression here would silently
 * break all Reference AI answers on iOS.
 *
 * OpenAI is mocked so no live API key is required.
 */

// ── Mock OpenAI BEFORE app is imported ───────────────────────────────────────
const mockCreate = jest.fn();

jest.mock('@workspace/integrations-openai-ai-server', () => ({
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

jest.mock('@workspace/integrations-openai-ai-server/batch', () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from 'supertest';
import app from '../src/app';
import { closePool } from './helpers/testDb';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Builds a minimal non-streaming OpenAI completion response. */
function mockCompletion(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reference/ask — validation
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/reference/ask — input validation', () => {
  it('returns 400 when question is missing', async () => {
    const res = await supertest(app).post('/api/reference/ask?stream=false').send({}).expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when question is an empty string', async () => {
    const res = await supertest(app)
      .post('/api/reference/ask?stream=false')
      .send({ question: '   ' })
      .expect(400);

    expect(res.body).toHaveProperty('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reference/ask?stream=false — JSON mode
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/reference/ask?stream=false — JSON mode (iOS path)', () => {
  it('returns { answer: string } when stream=false is passed', async () => {
    const AI_ANSWER =
      'GFCI stands for Ground Fault Circuit Interrupter. It trips within milliseconds to prevent shock.';

    mockCreate.mockResolvedValueOnce(mockCompletion(AI_ANSWER));

    const res = await supertest(app)
      .post('/api/reference/ask?stream=false')
      .send({ question: 'What does GFCI stand for?' })
      .expect(200);

    expect(res.body).toEqual({ answer: AI_ANSWER });
  });

  it('calls openai with stream:false when stream=false param is present', async () => {
    mockCreate.mockResolvedValueOnce(mockCompletion('Some answer.'));

    await supertest(app)
      .post('/api/reference/ask?stream=false')
      .send({ question: 'What is a GFCI?' })
      .expect(200);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as { stream: boolean };
    expect(callArgs.stream).toBe(false);
  });

  it('returns { answer: string } when Accept: application/json header is sent', async () => {
    const AI_ANSWER = 'EMT is Electrical Metallic Tubing, a thin-walled steel conduit.';

    mockCreate.mockResolvedValueOnce(mockCompletion(AI_ANSWER));

    const res = await supertest(app)
      .post('/api/reference/ask')
      .set('Accept', 'application/json')
      .send({ question: 'What is EMT conduit?' })
      .expect(200);

    expect(res.body).toEqual({ answer: AI_ANSWER });
  });

  it('returns an empty answer string when the model returns no content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });

    const res = await supertest(app)
      .post('/api/reference/ask?stream=false')
      .send({ question: 'What is EMT?' })
      .expect(200);

    expect(res.body).toHaveProperty('answer');
    expect(typeof res.body.answer).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reference/ask (SSE streaming — default)
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/reference/ask — SSE streaming (default)', () => {
  it('returns text/event-stream content-type when stream is not disabled', async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: ' world' } }] };
      yield { choices: [{ delta: {} }] };
    }

    mockCreate.mockResolvedValueOnce(fakeStream());

    const res = await supertest(app)
      .post('/api/reference/ask')
      .set('Accept', 'text/event-stream')
      .send({ question: 'What is a duplex receptacle?' });

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('data:');
  });
});
