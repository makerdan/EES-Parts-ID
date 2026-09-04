/**
 * Regression coverage for the private uploaded-object boundary.
 *
 * The storage adapter is represented by an in-memory namespace here; the
 * production adapter's namespace allow-list is covered by its exported policy
 * functions and the API route is exercised through the real app/auth stack.
 */
const objects = new Map<string, Buffer>();
const deleted = new Set<string>();

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

jest.mock("../src/lib/objectStorage", () => ({
  uploadCatalogImage: jest.fn(async (bytes: Buffer) => {
    const path = `/objects/uploads/private/catalog-images/test-photo.jpg`;
    objects.set(path, Buffer.from(bytes));
    return path;
  }),
  readPrivateObject: jest.fn(async (path: string) => {
    const value = objects.get(path);
    if (!value) throw new Error("not found");
    return Buffer.from(value);
  }),
  deletePrivateObjects: jest.fn(async (paths: Array<string | null | undefined>) => {
    for (const path of paths) {
      if (path?.startsWith("/objects/uploads/private/")) {
        objects.delete(path);
        deleted.add(path);
      }
    }
  }),
  isPrivateObjectPath: jest.fn((path: string) =>
    path.startsWith("/objects/uploads/private/"),
  ),
}));

import supertest from "supertest";
import { db, inventoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";
import {
  cleanupTestUser,
  seedTestUser,
} from "./helpers/testDb";

const ADMIN_TOKEN = signAdminToken();
const USER_TOKEN = "private-object-approved-user";
const PENDING_TOKEN = "private-object-pending-user";
const PRIVATE_FIXTURE_VENDOR = "JEST-PRIVATE-OBJECT-VENDOR";
const PRIVATE_FIXTURE_CATALOG = "JEST-PRIVATE-OBJECT-001";

let itemId: number;
let privatePath: string;

beforeAll(async () => {
  await seedTestUser({ clerkUserId: USER_TOKEN, status: "approved", role: "user" });
  await seedTestUser({ clerkUserId: PENDING_TOKEN, status: "pending", role: "user" });
  const [item] = await db
    .insert(inventoryTable)
    .values({
      vendor: PRIVATE_FIXTURE_VENDOR,
      catalog: PRIVATE_FIXTURE_CATALOG,
      description: "private object access fixture",
    })
    .returning();
  if (!item) throw new Error("private object fixture insert returned no row");
  itemId = item.id;
  privatePath = "/objects/uploads/private/catalog-images/opaque-photo.jpg";
  objects.set(privatePath, Buffer.from("jpeg-bytes"));
  await db
    .update(inventoryTable)
    .set({ imageUrl: privatePath, thumbnailUrl: privatePath })
    .where(eq(inventoryTable.id, itemId));
});

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  await db.delete(inventoryTable).where(eq(inventoryTable.id, itemId)).catch(() => {});
  await cleanupTestUser(USER_TOKEN).catch(() => {});
  await cleanupTestUser(PENDING_TOKEN).catch(() => {});
  objects.clear();
  deleted.clear();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("private inventory image access", () => {
  it("denies anonymous, pending, and direct path-only reads", async () => {
    await supertest(app)
      .get(`/api/inventory/${itemId}/photo?slot=1&variant=full`)
      .unset("Authorization")
      .expect(401);

    await supertest(app)
      .get(`/api/inventory/${itemId}/photo?slot=1&variant=full`)
      .set(auth(PENDING_TOKEN))
      .expect(403);

    // There is intentionally no generic anonymous /objects delivery route.
    await supertest(app).get(privatePath).expect(404);
  });

  it("serves approved users through the API with private cache semantics", async () => {
    const response = await supertest(app)
      .get(`/api/inventory/${itemId}/photo?slot=1&variant=full`)
      .set(auth(USER_TOKEN))
      .expect(200);

    expect(response.body.toString()).toBe("jpeg-bytes");
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does not expose the storage path in inventory API responses", async () => {
    const response = await supertest(app)
      .post("/api/inventory/search")
      .set(auth(USER_TOKEN))
      .send({ catalog: PRIVATE_FIXTURE_CATALOG })
      .expect(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).toContain(`/api/inventory/${itemId}/photo?`);
  });

  it("removes private photos during inventory deletion", async () => {
    await supertest(app)
      .delete(`/api/inventory/${itemId}`)
      .set(auth(ADMIN_TOKEN))
      .expect(200);
    expect(deleted).toEqual(new Set([privatePath]));
  });
});