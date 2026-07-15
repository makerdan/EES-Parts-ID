/**
 * Integration tests for inventory edit PATCH routes.
 *
 * Every test hits the real PostgreSQL database using a seeded item.
 * The only external dependency stubbed out is GCS (uploadCatalogImage) and
 * the image-resize utility — everything else (auth, DB, validation) runs for real.
 *
 * Covered routes:
 *   PATCH /api/inventory/:id/description
 *   PATCH /api/inventory/:id/expanded-description
 *   PATCH /api/inventory/:id/bins
 *   PATCH /api/inventory/:id/barcodes
 *   PATCH /api/inventory/:id/keywords
 *   PATCH /api/inventory/:id/dimensions  (partial + full)
 *   PATCH /api/inventory/:id/photo       (remove only — GCS upload is stubbed)
 *
 * Auth guard tests reuse the pattern from writeRouteAuth.integration.test.ts.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
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

// ── Stub GCS upload and image resize so photo tests work without real GCS ─────
jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn().mockResolvedValue("https://stub.gcs.test/img.jpg"),
}));

jest.mock("../src/utils/imageResize", () => ({
  resizeImages: jest.fn().mockResolvedValue({
    fullBuffer: Buffer.alloc(1),
    thumbnailBuffer: Buffer.alloc(1),
  }),
}));

jest.mock("../src/utils/aiHelpers", () => ({
  estimateImageBytes: jest.fn().mockReturnValue(1024),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import { db, inventoryTable, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import app from "../src/app";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";
import {
  cleanupEditableItem,
  closePool,
  seedEditableItem,
} from "./helpers/testDb";
import type { EditableItem } from "./helpers/testDb";

// ── Test-wide state ───────────────────────────────────────────────────────────

const ADMIN_TOKEN = ADMIN_TEST_USER_ID;
const NON_ADMIN_USER = "jest-edit-nonadmin";

let item: EditableItem;

/** Re-fetch the live DB row so we can assert what was actually committed. */
async function fetchRow(id: number) {
  const [row] = await db
    .select()
    .from(inventoryTable)
    .where(eq(inventoryTable.id, id));
  return row ?? null;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Insert a non-admin user so auth-guard tests can confirm 403.
  await db
    .insert(usersTable)
    .values({
      clerkUserId: NON_ADMIN_USER,
      email: "nonadmin@edit.test",
      status: "approved",
      role: "user",
    })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: "approved", role: "user" },
    });

  item = await seedEditableItem();

  // Authenticate all subsequent requests as admin by default.
  process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TOKEN;
}, 30_000);

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  // Cleanup can race the db-serial project's global pool teardown when Jest
  // runs both projects sequentially in the same process.  Silently skip on
  // pool-ended to avoid a false "suite failed" from afterAll errors; the
  // seedEditableItem() guard (DELETE before INSERT) ensures idempotency on
  // the next run anyway.
  try {
    await cleanupEditableItem();
    await db.delete(usersTable).where(like(usersTable.clerkUserId, "jest-edit-%"));
  } catch {
    // pool already closed — no-op
  }
  await closePool();
}, 30_000);

function withAuth(req: supertest.Test, token?: string): supertest.Test {
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

// =============================================================================
// Auth guard — every write route must reject unauthenticated / non-admin callers
// =============================================================================

describe("Edit route auth guard", () => {
  // Clear TEST_DEFAULT_AUTH_USER so no-token requests actually get 401,
  // then restore it so the rest of the suite keeps the admin default.
  beforeAll(() => { delete process.env.TEST_DEFAULT_AUTH_USER; });
  afterAll(() => { process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TOKEN; });

  type GuardRoute = {
    label: string;
    getPath: () => string;
    body: object;
  };

  const routes: GuardRoute[] = [
    { label: "description",          getPath: () => `/api/inventory/${item?.id ?? 0}/description`,          body: { description: "x" } },
    { label: "bins",                 getPath: () => `/api/inventory/${item?.id ?? 0}/bins`,                 body: { binLocations: ["X1"] } },
    { label: "barcodes",             getPath: () => `/api/inventory/${item?.id ?? 0}/barcodes`,             body: { barcodes: ["999"] } },
    { label: "keywords",             getPath: () => `/api/inventory/${item?.id ?? 0}/keywords`,             body: { keywords: ["relay"] } },
    { label: "dimensions",           getPath: () => `/api/inventory/${item?.id ?? 0}/dimensions`,           body: { length: 10 } },
    { label: "expanded-description", getPath: () => `/api/inventory/${item?.id ?? 0}/expanded-description`, body: { expandedDescription: "x" } },
    { label: "photo",                getPath: () => `/api/inventory/${item?.id ?? 0}/photo`,                body: { remove: true, slot: 1 } },
  ];

  for (const route of routes) {
    describe(`PATCH …/${route.label}`, () => {
      it("no token → 401", async () => {
        const res = await supertest(app).patch(route.getPath()).send(route.body);
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty("error");
      });

      it("approved non-admin → 403", async () => {
        const res = await withAuth(
          supertest(app).patch(route.getPath()).send(route.body),
          NON_ADMIN_USER,
        );
        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("error");
      });

      it("admin → passes auth (not 401/403)", async () => {
        const res = await withAuth(
          supertest(app).patch(route.getPath()).send(route.body),
          ADMIN_TOKEN,
        );
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });
  }
});

// =============================================================================
// PATCH /api/inventory/:id/description
// =============================================================================

describe("PATCH /api/inventory/:id/description — happy paths", () => {
  it("updates description and commits the value to the DB", async () => {
    const newDesc = "Updated description via integration test";

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: newDesc }),
      ADMIN_TOKEN,
    ).expect(200);

    // Response shape check
    expect(res.body).toHaveProperty("description", newDesc);
    expect(res.body).toHaveProperty("id", item.id);

    // DB read-back confirms the value was committed
    const row = await fetchRow(item.id);
    expect(row?.description).toBe(newDesc);

    // Restore original value for subsequent tests
    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });

  it("accepts an empty string (clears the description)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: "" }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.description).toBe("");
    const row = await fetchRow(item.id);
    expect(row?.description).toBe("");

    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });

  it("accepts a 500-character description (at the limit)", async () => {
    const atLimit = "x".repeat(500);
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: atLimit }),
      ADMIN_TOKEN,
    ).expect(200);

    await db
      .update(inventoryTable)
      .set({ description: item.description })
      .where(eq(inventoryTable.id, item.id));
  });
});

describe("PATCH /api/inventory/:id/description — error paths", () => {
  it("returns 400 for a 501-character description and leaves DB unchanged", async () => {
    const over = "x".repeat(501);
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({ description: over }),
      ADMIN_TOKEN,
    ).expect(400);

    // DB row must be unchanged
    const row = await fetchRow(item.id);
    expect(row?.description).toBe(item.description);
  });

  it("returns 400 when description is absent", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/description`)
        .send({}),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/description")
        .send({ description: "hi" }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/expanded-description
// =============================================================================

describe("PATCH /api/inventory/:id/expanded-description — happy paths", () => {
  it("updates expanded description and returns { success: true }", async () => {
    const text = "A detailed expanded description for the integration test part.";

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/expanded-description`)
        .send({ expandedDescription: text }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body).toEqual({ success: true });

    const row = await fetchRow(item.id);
    expect(row?.expandedDescription).toBe(text);

    await db
      .update(inventoryTable)
      .set({ expandedDescription: item.expandedDescription })
      .where(eq(inventoryTable.id, item.id));
  });

  it("clears expanded description when null is sent", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/expanded-description`)
        .send({ expandedDescription: null }),
      ADMIN_TOKEN,
    ).expect(200);

    const row = await fetchRow(item.id);
    expect(row?.expandedDescription).toBeNull();

    await db
      .update(inventoryTable)
      .set({ expandedDescription: item.expandedDescription })
      .where(eq(inventoryTable.id, item.id));
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/expanded-description")
        .send({ expandedDescription: "x" }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/bins
// =============================================================================

describe("PATCH /api/inventory/:id/bins — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ binLocations: item.binLocations })
      .where(eq(inventoryTable.id, item.id));
  });

  it("replaces bin locations and commits to DB", async () => {
    const newBins = ["NEW-A1", "NEW-B2", "NEW-C3"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: newBins }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(newBins);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(newBins);
  });

  it("deduplicates case-insensitively before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: ["AA1", "aa1", "BB2"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(["AA1", "BB2"]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(["AA1", "BB2"]);
  });

  it("trims whitespace and drops empty strings before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: ["  TRIM-01  ", "", " ", "TRIM-02"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual(["TRIM-01", "TRIM-02"]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(["TRIM-01", "TRIM-02"]);
  });

  it("accepts an empty array and clears the bins in DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.binLocations).toEqual([]);
    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/bins — error paths", () => {
  it("returns 400 when binLocations is not an array and leaves DB unchanged", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/bins`)
        .send({ binLocations: "not-an-array" }),
      ADMIN_TOKEN,
    ).expect(400);

    const row = await fetchRow(item.id);
    expect(row?.binLocations).toEqual(item.binLocations);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/bins")
        .send({ binLocations: ["A1"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/barcodes
// =============================================================================

describe("PATCH /api/inventory/:id/barcodes — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ barcodes: item.barcodes })
      .where(eq(inventoryTable.id, item.id));
  });

  it("replaces barcodes and commits to DB", async () => {
    const newBarcodes = ["111222333444", "555666777888"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: newBarcodes }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual(newBarcodes);
    const row = await fetchRow(item.id);
    expect((row as unknown as { barcodes?: string[] })?.barcodes).toEqual(newBarcodes);
  });

  it("deduplicates and trims barcodes before writing to DB", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: ["  ABC  ", "ABC", "XYZ"] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual(["ABC", "XYZ"]);
  });

  it("accepts an empty array (clears barcodes)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.barcodes).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/barcodes — error paths", () => {
  it("returns 400 when barcodes is not an array", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/barcodes`)
        .send({ barcodes: "123" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/barcodes")
        .send({ barcodes: ["123"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/keywords
// =============================================================================

describe("PATCH /api/inventory/:id/keywords — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ aiKeywords: item.aiKeywords, pinnedKeywords: item.aiKeywords })
      .where(eq(inventoryTable.id, item.id));
  });

  it("replaces aiKeywords + pinnedKeywords and commits to DB", async () => {
    const newKeywords = ["breaker", "20a", "panel"];

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: newKeywords }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.aiKeywords).toEqual(newKeywords);

    const row = await fetchRow(item.id);
    expect(row?.aiKeywords).toEqual(newKeywords);
    // The route also writes pinnedKeywords = keywords to the DB
    expect(row?.pinnedKeywords).toEqual(newKeywords);
  });

  it("accepts an empty keywords array (clears keywords)", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: [] }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.aiKeywords).toEqual([]);
  });
});

describe("PATCH /api/inventory/:id/keywords — error paths", () => {
  it("returns 400 when keywords is not an array", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/keywords`)
        .send({ keywords: "relay" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/keywords")
        .send({ keywords: ["relay"] }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/dimensions
// =============================================================================

describe("PATCH /api/inventory/:id/dimensions — happy paths", () => {
  afterEach(async () => {
    await db
      .update(inventoryTable)
      .set({ dimensions: item.dimensions })
      .where(eq(inventoryTable.id, item.id));
  });

  it("updates a single dimension field (partial) and preserves unrelated fields", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 200 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions.length).toBe(200);

    const row = await fetchRow(item.id);
    const dims = row?.dimensions as typeof item.dimensions;
    expect(dims?.length).toBe(200);
    // width and height were preserved from original (50, 25)
    expect(dims?.width).toBe(50);
    expect(dims?.height).toBe(25);
  });

  it("updates all four dimension fields", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 300, width: 150, height: 75, diameter: 40 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions).toMatchObject({ length: 300, width: 150, height: 75, diameter: 40 });

    const row = await fetchRow(item.id);
    const dims = row?.dimensions as typeof item.dimensions;
    expect(dims?.length).toBe(300);
    expect(dims?.diameter).toBe(40);
  });

  it("clears a dimension field when null is sent", async () => {
    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: null }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.dimensions.length).toBeNull();
    const row = await fetchRow(item.id);
    expect((row?.dimensions as typeof item.dimensions)?.length).toBeNull();
  });
});

describe("PATCH /api/inventory/:id/dimensions — error paths", () => {
  it("returns 400 for a negative dimension value and leaves DB unchanged", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: -10 }),
      ADMIN_TOKEN,
    ).expect(400);

    const row = await fetchRow(item.id);
    expect((row?.dimensions as typeof item.dimensions)?.length).toBe(item.dimensions?.length);
  });

  it("returns 400 for a dimension value over 100,000", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: 100_001 }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 400 for a non-numeric dimension value", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/dimensions`)
        .send({ length: "not-a-number" }),
      ADMIN_TOKEN,
    ).expect(400);
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/dimensions")
        .send({ length: 10 }),
      ADMIN_TOKEN,
    ).expect(404);
  });
});

// =============================================================================
// PATCH /api/inventory/:id/photo — remove only (GCS upload stubbed)
// =============================================================================

describe("PATCH /api/inventory/:id/photo — remove", () => {
  it("removes slot-1 photo and commits null imageUrl to DB", async () => {
    // First set imageUrl to a non-null value directly in DB so remove has something to clear.
    await db
      .update(inventoryTable)
      .set({ imageUrl: "https://existing.example.com/img.jpg", thumbnailUrl: "https://existing.example.com/thumb.jpg" })
      .where(eq(inventoryTable.id, item.id));

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ remove: true, slot: 1 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.imageUrl).toBeNull();
    expect(res.body.thumbnailUrl).toBeNull();

    const row = await fetchRow(item.id);
    expect(row?.imageUrl).toBeNull();
    expect(row?.thumbnailUrl).toBeNull();
  });

  it("removes slot-2 photo and commits null imageUrl2 to DB", async () => {
    await db
      .update(inventoryTable)
      .set({ imageUrl2: "https://existing.example.com/img2.jpg", thumbnailUrl2: "https://existing.example.com/thumb2.jpg" })
      .where(eq(inventoryTable.id, item.id));

    const res = await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ remove: true, slot: 2 }),
      ADMIN_TOKEN,
    ).expect(200);

    expect(res.body.imageUrl2).toBeNull();
    expect(res.body.thumbnailUrl2).toBeNull();

    const row = await fetchRow(item.id);
    expect(row?.imageUrl2).toBeNull();
    expect(row?.thumbnailUrl2).toBeNull();
  });

  it("returns 404 for an unknown item id", async () => {
    await withAuth(
      supertest(app)
        .patch("/api/inventory/9999999/photo")
        .send({ remove: true, slot: 1 }),
      ADMIN_TOKEN,
    ).expect(404);
  });

  it("returns 400 when imageBase64 is absent and remove is not set", async () => {
    await withAuth(
      supertest(app)
        .patch(`/api/inventory/${item.id}/photo`)
        .send({ slot: 1 }),
      ADMIN_TOKEN,
    ).expect(400);
  });
});
