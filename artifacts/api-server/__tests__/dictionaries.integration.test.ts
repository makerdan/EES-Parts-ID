/**
 * Integration tests for GET /api/dictionaries/lookup.
 *
 * Exercises the real database (abbreviation, synonym, misspelling, slang tables).
 * Assumes the seed data shipped with the project is present (no fixture seeding needed).
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

beforeAll(() => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
});
afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
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
      .get("/api/dictionaries/lookup?term=ser")
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

  it("expands the abbreviation 'ser' to service-entrance-related terms", async () => {
    // 'ser' is seeded in the abbreviation_map table
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=ser")
      .expect(200);

    expect(res.body.abbreviations.length).toBeGreaterThan(0);
    const joined = res.body.abbreviations.join(" ").toLowerCase();
    expect(joined).toMatch(/service/);
  });

  it("returns slang expansions for 'stab-in'", async () => {
    // 'stab-in' is seeded in the electrical_slang_map table
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=stab-in")
      .expect(200);

    expect(res.body.slangTerms.length).toBeGreaterThan(0);
    const joined = res.body.slangTerms.join(" ").toLowerCase();
    expect(joined).toMatch(/push|connector|backstab/);
  });

  it("returns a misspelling correction for 'gcfi' → 'gfci'", async () => {
    // 'gcfi' is seeded in the misspelling_map table
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=gcfi")
      .expect(200);

    expect(res.body.correction).toBe("gfci");
  });

  it("returns synonym expansions for 'afci'", async () => {
    // 'afci' is seeded in the synonym_map table
    const res = await supertest(app)
      .get("/api/dictionaries/lookup?term=afci")
      .expect(200);

    expect(res.body.synonyms.length).toBeGreaterThan(0);
    const joined = res.body.synonyms.join(" ").toLowerCase();
    expect(joined).toMatch(/arc fault/);
  });

  it("is case-insensitive — 'SER' and 'ser' return the same abbreviations", async () => {
    const lower = await supertest(app)
      .get("/api/dictionaries/lookup?term=ser")
      .expect(200);
    const upper = await supertest(app)
      .get("/api/dictionaries/lookup?term=SER")
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
