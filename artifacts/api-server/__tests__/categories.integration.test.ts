// Integration tests for /api/categories: tree shape, level invariants,
// leaf-only assignment, cross-level merge guard, coverage counts.

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

import supertest from "supertest";
import { eq } from "drizzle-orm";
import app from "../src/app";
import { signAdminToken } from "../src/routes/admin";
import {
  db,
  categoryNodeTable,
  inventoryCategoryTable,
  inventoryTable,
} from "@workspace/db";
import { seedTaxonomy } from "../src/seed/taxonomy";
import { closePool } from "./helpers/testDb";

const ADMIN_SECRET = "jest-categories-test-secret";
let adminToken: string;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = ADMIN_SECRET;
  adminToken = signAdminToken(Date.now(), ADMIN_SECRET);
  // Make sure the seeded taxonomy exists. seedTaxonomy is idempotent.
  await seedTaxonomy();
}, 30_000);

afterAll(async () => {
  await closePool();
}, 30_000);

describe("GET /api/categories/tree", () => {
  it("returns the three-level seeded taxonomy", async () => {
    const res = await supertest(app).get("/api/categories/tree").expect(200);
    expect(res.body).toHaveProperty("tree");
    expect(Array.isArray(res.body.tree)).toBe(true);
    expect(res.body.tree.length).toBeGreaterThan(0);
    // Every root must be a category, every child of a category must be a
    // subcategory, every grandchild must be a type.
    for (const cat of res.body.tree) {
      expect(cat.level).toBe("category");
      for (const sub of cat.children ?? []) {
        expect(sub.level).toBe("subcategory");
        for (const t of sub.children ?? []) {
          expect(t.level).toBe("type");
        }
      }
    }
  });
});

describe("GET /api/categories/coverage", () => {
  it("returns numeric counts", async () => {
    const res = await supertest(app).get("/api/categories/coverage").expect(200);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.classified).toBe("number");
    expect(typeof res.body.uncategorized).toBe("number");
  });
});

describe("PATCH /api/categories/:nodeId — level invariants", () => {
  it("rejects re-parenting a type under another type", async () => {
    const types = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "type"));
    if (types.length < 2) return; // nothing to test against
    const a = types[0]!;
    const b = types[1]!;
    const res = await supertest(app)
      .patch(`/api/categories/${a.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ parentId: b.id })
      .expect(400);
    expect(String(res.body.error).toLowerCase()).toContain("subcategory");
  });

  it("rejects making a subcategory a root (parentId=null)", async () => {
    const [sub] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "subcategory"))
      .limit(1);
    if (!sub) return;
    const res = await supertest(app)
      .patch(`/api/categories/${sub.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ parentId: null })
      .expect(400);
    expect(String(res.body.error).toLowerCase()).toContain("category");
  });

  it("requires admin auth", async () => {
    const [t] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "type"))
      .limit(1);
    if (!t) return;
    await supertest(app)
      .patch(`/api/categories/${t.id}`)
      .send({ name: "Should not work" })
      .expect(401);
  });
});

describe("POST /api/categories/:nodeId/assign — leaf-only invariant", () => {
  it("refuses to assign inventory to a non-leaf (category) node", async () => {
    const [cat] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "category"))
      .limit(1);
    const [item] = await db.select({ id: inventoryTable.id }).from(inventoryTable).limit(1);
    if (!cat || !item) return; // can't run on an empty DB
    const res = await supertest(app)
      .post(`/api/categories/${cat.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ inventoryId: item.id })
      .expect(400);
    expect(String(res.body.error).toLowerCase()).toContain("type");
  });

  it("accepts assignment to a leaf type node and is idempotent", async () => {
    const [t] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "type"))
      .limit(1);
    const [item] = await db.select({ id: inventoryTable.id }).from(inventoryTable).limit(1);
    if (!t || !item) return;
    await supertest(app)
      .post(`/api/categories/${t.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ inventoryId: item.id })
      .expect(200);
    // Second call must replace, not duplicate (composite PK guarantees this).
    await supertest(app)
      .post(`/api/categories/${t.id}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ inventoryId: item.id })
      .expect(200);
    const rows = await db
      .select()
      .from(inventoryCategoryTable)
      .where(eq(inventoryCategoryTable.inventoryId, item.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classifiedBy).toBe("manual");
  });
});

describe("PATCH /api/inventory/:id/category — leaf-only invariant", () => {
  it("refuses to assign to a non-leaf (subcategory) node", async () => {
    const [sub] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "subcategory"))
      .limit(1);
    const [item] = await db.select({ id: inventoryTable.id }).from(inventoryTable).limit(1);
    if (!sub || !item) return;
    const res = await supertest(app)
      .patch(`/api/inventory/${item.id}/category`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryNodeId: sub.id })
      .expect(400);
    expect(String(res.body.error).toLowerCase()).toContain("type");
  });
});

describe("POST /api/categories/merge — cross-level guard", () => {
  it("refuses to merge nodes at different levels", async () => {
    const [cat] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "category"))
      .limit(1);
    const [type] = await db
      .select()
      .from(categoryNodeTable)
      .where(eq(categoryNodeTable.level, "type"))
      .limit(1);
    if (!cat || !type) return;
    const res = await supertest(app)
      .post("/api/categories/merge")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sourceId: cat.id, targetId: type.id })
      .expect(400);
    expect(String(res.body.error).toLowerCase()).toContain("level");
  });
});
