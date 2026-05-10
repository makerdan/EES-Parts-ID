/**
 * Smoke tests for GET /healthz.
 *
 * The health endpoint returns 503 while the Quick Lookup seeder has not yet
 * verified all 12 chip rows, and 200 once it has. This gate prevents the
 * Replit proxy from routing production traffic to a cold server before the
 * chip cache is populated.
 *
 * `isQuickLookupSeederReady` is mocked so the test is fully synchronous and
 * requires no database or AI connection.
 */

// ── Mocks — must come before any imports ─────────────────────────────────────

const mockIsReady = jest.fn<boolean, []>();

jest.mock('../src/lib/seedQuickLookups', () => ({
  isQuickLookupSeederReady: () => mockIsReady(),
  seedQuickLookups: jest.fn().mockResolvedValue(undefined),
  startQuickLookupScheduler: jest.fn(),
  stopQuickLookupScheduler: jest.fn(),
}));

jest.mock('@workspace/integrations-openai-ai-server', () => ({
  openai: { chat: { completions: { create: jest.fn() } } },
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

// ── Imports after mocks ───────────────────────────────────────────────────────

import supertest from 'supertest';
import app from '../src/app';
import { closePool } from './helpers/testDb';

afterAll(async () => {
  await closePool();
});

afterEach(() => {
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /healthz — seeder readiness gate', () => {
  it('returns 503 with { status: "seeding" } while the seeder is not ready', async () => {
    mockIsReady.mockReturnValue(false);

    const res = await supertest(app).get('/api/healthz').expect(503);

    expect(res.body).toEqual({ status: 'seeding' });
  });

  it('returns 200 with { status: "ok" } once the seeder is ready', async () => {
    mockIsReady.mockReturnValue(true);

    const res = await supertest(app).get('/api/healthz').expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });
});
