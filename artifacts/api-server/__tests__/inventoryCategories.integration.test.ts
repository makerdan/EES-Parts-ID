/**
 * Integration tests for GET /api/inventory/categories.
 *
 * Exercises the real database via the inventory_chip_text SQL function and the
 * taxonomy classification pass. Seeds JEST-ITG- fixtures so at least some rows
 * exist regardless of the surrounding data set.
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
import { cleanupFixtures, seedFixtures } from "./helpers/testDb";

beforeAll(async () => {
  process.env.ADMIN_CLERK_USER_ID = "jest-admin-user";
  process.env.TEST_DEFAULT_AUTH_USER = "jest-admin-user";
  await seedFixtures([
    {
      vendor: "EATON",
      catalog: "JEST-ITG-CAT-BR120",
      description: "1 Pole 20A 120/240V Circuit Breaker",
      dimensions: { width: 25, height: 80, length: null, diameter: null },
    },
    {
      vendor: "HUBBELL",
      catalog: "JEST-ITG-CAT-RECEP",
      description: "20A 125V Duplex Receptacle Ivory",
      dimensions: { width: 45, height: 105, length: null, diameter: null },
    },
  ]);
});

afterAll(async () => {
  await cleanupFixtures();
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
}, 30_000);

const CATEGORIES_TIMEOUT = 30_000;

describe("GET /api/inventory/categories", () => {
  it(
    "returns the full taxonomy tree with counts",
    async () => {
      const res = await supertest(app).get("/api/inventory/categories").expect(200);

      expect(Array.isArray(res.body.categories)).toBe(true);
      expect(res.body.categories.length).toBeGreaterThan(1);

      for (const cat of res.body.categories) {
        expect(typeof cat.slug).toBe("string");
        expect(typeof cat.label).toBe("string");
        expect(typeof cat.color).toBe("string");
        expect(typeof cat.count).toBe("number");
        expect(Array.isArray(cat.subcategories)).toBe(true);
        for (const sub of cat.subcategories) {
          expect(typeof sub.slug).toBe("string");
          expect(typeof sub.count).toBe("number");
          expect(Array.isArray(sub.itemTypes)).toBe(true);
        }
      }

      // Uncategorized node is always appended last
      const last = res.body.categories[res.body.categories.length - 1];
      expect(last.slug).toBe("uncategorized");
    },
    CATEGORIES_TIMEOUT,
  );

  it(
    "counts the seeded breaker fixture under a breaker-related item type",
    async () => {
      const res = await supertest(app).get("/api/inventory/categories").expect(200);

      // Flatten all item types and confirm at least one breaker-ish slug has count > 0
      const itemTypes: Array<{ slug: string; count: number }> = [];
      for (const cat of res.body.categories) {
        for (const sub of cat.subcategories) {
          itemTypes.push(...sub.itemTypes);
        }
      }
      const breakerish = itemTypes.filter(
        (it) => /breaker/i.test(it.slug) && it.count > 0,
      );
      expect(breakerish.length).toBeGreaterThan(0);
    },
    CATEGORIES_TIMEOUT,
  );

  it(
    "accepts numeric dimension filters and narrows counts",
    async () => {
      const unfiltered = await supertest(app).get("/api/inventory/categories").expect(200);
      const filtered = await supertest(app)
        .get("/api/inventory/categories?minWidth=1&maxWidth=30")
        .expect(200);

      const total = (body: { categories: Array<{ count: number }> }) =>
        body.categories.reduce((sum, c) => sum + c.count, 0);

      // The width filter can only ever shrink (or keep equal) the counts
      expect(total(filtered.body)).toBeLessThanOrEqual(total(unfiltered.body));
    },
    CATEGORIES_TIMEOUT,
  );

  it("returns 400 for a non-numeric dimension parameter", async () => {
    const res = await supertest(app)
      .get("/api/inventory/categories?minWidth=abc")
      .expect(400);

    expect(res.body.error).toMatch(/minWidth/);
    expect(res.body.error).toMatch(/finite number/i);
  });

  it("returns 400 for an Infinity dimension parameter", async () => {
    const res = await supertest(app)
      .get("/api/inventory/categories?maxHeight=Infinity")
      .expect(400);

    expect(res.body.error).toMatch(/maxHeight/);
  });

  it(
    "ignores empty dimension parameters",
    async () => {
      const res = await supertest(app)
        .get("/api/inventory/categories?minWidth=&maxWidth=")
        .expect(200);
      expect(Array.isArray(res.body.categories)).toBe(true);
    },
    CATEGORIES_TIMEOUT,
  );
});
