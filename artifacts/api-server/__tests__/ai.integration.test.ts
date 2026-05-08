/**
 * Integration tests for POST /api/ai/identify.
 *
 * The OpenAI client is mocked so no live API key is required.
 * The database IS used for catalog lookup and telemetry, but test data
 * won't match any real rows so results will always be empty arrays.
 */

// ── Mock OpenAI integration BEFORE app is imported ───────────────────────────
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

// Minimal valid base64 string (1×1 white pixel JPEG)
const TINY_BASE64_JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EAB4QAAEEAgMAAAAAAAAAAAAAAAEAAgMREiExQf/EABUBAQEAAAAAAAAAAAAAAAAAAAID/8QAFxEBAQEBAAAAAAAAAAAAAAAAAQACEf/aAAwDAQACEQMRAD8AoN1tq+bNT5e1C7RERFk//9k=';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a valid Vision contract JSON string for the given overrides. */
function visionContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    catalog_guess: null,
    vendor_guess: null,
    type_guess: null,
    attributes: null,
    descriptive_tokens: [] as string[],
    confidence: null,
    notes: null,
    ...overrides,
  });
}

beforeAll(() => {
  process.env.ADMIN_PASSWORD = 'jest-ai-test-secret';
});

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ai/identify
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/ai/identify', () => {
  it('returns 400 when no images are provided', async () => {
    const res = await supertest(app).post('/api/ai/identify').send({}).expect(400);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/image/i);
  });

  it('returns 400 when images is an empty array', async () => {
    const res = await supertest(app).post('/api/ai/identify').send({ images: [] }).expect(400);

    expect(res.body).toHaveProperty('error');
  });

  it('returns 200 with the correct shape for a successful mocked response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: visionContent({
              catalog_guess: 'BR120',
              vendor_guess: 'Eaton',
              type_guess: 'circuit breaker',
              attributes: {
                amperage: 20,
                poles: 1,
                voltage: null,
                trade_size_in: null,
                color: null,
              },
              descriptive_tokens: ['circuit breaker', 'BR120'],
              confidence: 0.92,
              notes: 'Single pole 20A residential circuit breaker.',
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post('/api/ai/identify')
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(200);

    expect(res.body).toHaveProperty('searchTerms');
    expect(res.body).toHaveProperty('synonyms');
    expect(res.body).toHaveProperty('relatedTerms');
    expect(res.body).toHaveProperty('manufacturerVerified');
    expect(res.body).toHaveProperty('detectedVendor');
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('results');
    expect(res.body).toHaveProperty('match_type');

    expect(Array.isArray(res.body.searchTerms)).toBe(true);
    expect(res.body.searchTerms).toContain('circuit breaker');
    expect(res.body.detectedVendor).toBe('Eaton');
    expect(res.body.manufacturerVerified).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('returns 422 when the AI response contains no extractable JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'This part looks like a breaker. No JSON here.' } }],
    });

    const res = await supertest(app)
      .post('/api/ai/identify')
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(422);

    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/could not identify/i);
  });

  it('returns 200 with empty defaults when the AI response is an empty object', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{}' } }],
    });

    const res = await supertest(app)
      .post('/api/ai/identify')
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(200);

    expect(res.body.searchTerms).toEqual([]);
    expect(res.body.synonyms).toEqual([]);
    expect(res.body.relatedTerms).toEqual([]);
    expect(res.body.manufacturerVerified).toBe(false);
    expect(res.body.detectedVendor).toBeNull();
    // summary defaults to "Part identified" when no fields are populated
    expect(typeof res.body.summary).toBe('string');
  });

  it('passes optional context fields to the AI prompt (smoke test)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: visionContent({
              vendor_guess: null,
              type_guess: 'toggle switch',
              descriptive_tokens: ['switch', 'toggle'],
              confidence: 0.75,
            }),
          },
        },
      ],
    });

    const res = await supertest(app)
      .post('/api/ai/identify')
      .send({
        images: [TINY_BASE64_JPEG],
        keywords: 'toggle switch',
        vendor: 'Hubbell',
        color: 'white',
      })
      .expect(200);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // Verify the call was made with the correct model
    const callArg = mockCreate.mock.calls[0][0];
    expect(callArg.model).toBe('gpt-4o');

    expect(res.body.searchTerms).toContain('switch');
  });

  it('returns 500 when the OpenAI client throws', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    const res = await supertest(app)
      .post('/api/ai/identify')
      .send({ images: [TINY_BASE64_JPEG] })
      .expect(500);

    expect(res.body).toHaveProperty('error');
  });
});
