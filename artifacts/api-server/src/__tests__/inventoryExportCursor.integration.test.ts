import { randomUUID } from "node:crypto";

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcessWithSSE: jest.fn(),
}));
jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { db, inventoryTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import supertest from "supertest";

import app from "../app";

const prefix = `JEST-ITG-EXPORT-${randomUUID()}`;
const ownedIds: number[] = [];

afterAll(async () => {
  if (ownedIds.length) await db.delete(inventoryTable).where(inArray(inventoryTable.id, ownedIds));
});

it("continues filtered inventory in id order, excluding later inserts", async () => {
  const inserted = await db.insert(inventoryTable).values(
    [1, 2, 3].map(i => ({
      vendor: "JEST",
      catalog: `${prefix}-${i}`,
      binLocations: [prefix],
    })),
  ).returning({ id: inventoryTable.id });
  ownedIds.push(...inserted.map(row => row.id));

  const first = await supertest(app)
    .get("/api/inventory")
    .query({ after_id: 0, limit: 2, binPrefix: prefix });
  expect(first.status).toBe(200);
  expect(first.body.total).toBe(3);
  expect(first.body.items.map((row: { id: number }) => row.id)).toEqual(ownedIds.slice(0, 2));
  expect(first.body.throughId).toBeGreaterThanOrEqual(ownedIds[2]);

  const [late] = await db.insert(inventoryTable).values({
    vendor: "JEST",
    catalog: `${prefix}-late`,
    binLocations: [prefix],
  }).returning({ id: inventoryTable.id });
  ownedIds.push(late!.id);

  const second = await supertest(app)
    .get("/api/inventory")
    .query({ after_id: ownedIds[1], through_id: first.body.throughId, limit: 2, binPrefix: prefix, total: first.body.total });
  expect(second.status).toBe(200);
  expect(second.body.items.map((row: { id: number }) => row.id)).toEqual([ownedIds[2]]);
  expect(second.body.throughId).toBe(first.body.throughId);
  expect(second.body.total).toBe(3);
});

it("handles empty filters and rejects invalid cursors and deep offsets", async () => {
  const empty = await supertest(app).get("/api/inventory")
    .query({ after_id: 0, limit: 2, binPrefix: `${prefix}-absent` });
  expect(empty.status).toBe(200);
  expect(empty.body.items).toEqual([]);
  expect(empty.body.total).toBe(0);
  expect(empty.body.throughId).toEqual(expect.any(Number));

  for (const query of [
    { after_id: -1 },
    { after_id: 1 },
    { after_id: 0, through_id: 1 },
    { after_id: 1, through_id: 2, page: 2 },
    { through_id: 2 },
  ]) {
    expect((await supertest(app).get("/api/inventory").query(query)).status).toBe(400);
  }
  expect((await supertest(app).get("/api/inventory").query({ page: 22, limit: 500 })).status).toBe(400);
});