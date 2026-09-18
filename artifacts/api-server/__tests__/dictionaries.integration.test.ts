/**
 * Integration tests for GET /api/dictionaries/lookup.
 *
 * Exercises the real database (abbreviation, synonym, misspelling, slang tables)
 * with idempotent fixtures, so the suite also runs against an empty test database.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
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

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import {
  cleanupDictionaryFixtures,
  type DictionaryFixtures,
  seedDictionaryFixtures,
  workerQualifiedUserId,
} from "./helpers/testDb";
import { setTestEnv } from "./helpers/testEnv";

const TEST_ADMIN_USER_ID = workerQualifiedUserId("jest-admin-user");
let restoreTestEnv: (() => void) | undefined;
let dictionaryFixtures: DictionaryFixtures;
beforeAll(async () => {
  restoreTestEnv = setTestEnv({
    ADMIN_CLERK_USER_ID: TEST_ADMIN_USER_ID,
    TEST_DEFAULT_AUTH_USER: TEST_ADMIN_USER_ID,
  });
  dictionaryFixtures = await seedDictionaryFixtures();
});
afterAll(async () => {
  await cleanupDictionaryFixtures();
  restoreTestEnv?.();
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dictionaries/lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/dictionaries/lookup", () => {
  it("returns 400 when the term query param is missing", async () => {
    const res = await supertest(app)
      .get("/api/dictionaries/lookup")
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/term/i);
  });

  it("returns 400 when term is an empty string", async () => {
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=")
      .expect(400);

    expect(res.body).toHaveProperty("error");
  });

  it("returns the correct response shape for any lookup", async () => {
    const res = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.abbreviation)}`)
      .expect(200);

    expect(res.body).toHaveProperty("abbreviations");
    expect(res.body).toHaveProperty("synonyms");
    expect(res.body).toHaveProperty("correction");
    expect(res.body).toHaveProperty("vendorNames");
    expect(res.body).toHaveProperty("slangTerms");
    expect(Array.isArray(res.body.abbreviations)).toBe(true);
    expect(Array.isArray(res.body.synonyms)).toBe(true);
    expect(Array.isArray(res.body.vendorNames)).toBe(true);
    expect(Array.isArray(res.body.slangTerms)).toBe(true);
  });

  it("expands the suite-owned abbreviation to service-entrance-related terms", async () => {
    const res = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.abbreviation)}`)
      .expect(200);

    expect(res.body.abbreviations.length).toBeGreaterThan(0);
    const joined = res.body.abbreviations.join(" ").toLowerCase();
    expect(joined).toMatch(/service/);
  });

  it("returns slang expansions for the suite-owned slang term", async () => {
    const res = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.slang)}`)
      .expect(200);

    expect(res.body.slangTerms.length).toBeGreaterThan(0);
    const joined = res.body.slangTerms.join(" ").toLowerCase();
    expect(joined).toMatch(/push|connector|backstab/);
  });

  it("returns the suite-owned misspelling correction", async () => {
    const res = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.misspelling)}`)
      .expect(200);

    expect(res.body.correction).toBe(dictionaryFixtures.correction);
  });

  it("returns the suite-owned synonym expansions", async () => {
    const res = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.synonym)}`)
      .expect(200);

    expect(res.body.synonyms.length).toBeGreaterThan(0);
    const joined = res.body.synonyms.join(" ").toLowerCase();
    expect(joined).toMatch(/arc fault/);
  });

  it("is case-insensitive for the suite-owned abbreviation", async () => {
    const lower = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.abbreviation)}`)
      .expect(200);
    const upper = await supertest(app)
      .get(`/api/dictionaries/lookup?term=${encodeURIComponent(dictionaryFixtures.abbreviation.toUpperCase())}`)
      .expect(200);

    expect(lower.body.abbreviations).toEqual(upper.body.abbreviations);
  });

  it("returns empty arrays and null correction for an unknown term without erroring", async () => {
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=zzznounknownterm99999")
      .expect(200);

    expect(res.body.abbreviations).toEqual([]);
    expect(res.body.synonyms).toEqual([]);
    expect(res.body.correction).toBeNull();
    expect(res.body.vendorNames).toEqual([]);
    expect(res.body.slangTerms).toEqual([]);
  });
});
