/** Request-level slot parsing and mutation isolation for map anchors. */
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

import { db, mapAnchorPointsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import supertest from "supertest";

import app from "../src/app";
import { signAdminToken } from "./helpers/adminAuth";

const token = signAdminToken();
const body = { name: "slot parsing fixture", svgX: 10, svgY: 20, worldX: 30, worldY: 40 };

describe("PUT and DELETE /api/admin/map-anchors/:slot", () => {
  it("rejects malformed slots without touching slot 1, but accepts exact valid slots", async () => {
    const [original] = await db.select().from(mapAnchorPointsTable).where(eq(mapAnchorPointsTable.id, 1));
    try {
      await supertest(app)
        .put("/api/admin/map-anchors/1")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(200);

      for (const malformed of [
        "1junk", "1.5", "1e2", "+1", "-1", "01", "0", "4", "9007199254740992",
      ]) {
        await supertest(app)
          .put(`/api/admin/map-anchors/${malformed}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ ...body, name: "overwritten" })
          .expect(400);
        await supertest(app)
          .delete(`/api/admin/map-anchors/${malformed}`)
          .set("Authorization", `Bearer ${token}`)
          .expect(400);
        const [stored] = await db.select().from(mapAnchorPointsTable).where(eq(mapAnchorPointsTable.id, 1));
        expect(stored?.name).toBe(body.name);
        expect(stored?.svgX).toBe(body.svgX);
      }

      await supertest(app)
        .delete("/api/admin/map-anchors/1")
        .set("Authorization", `Bearer ${token}`)
        .expect(200, { deleted: true });
      const remaining = await db.select().from(mapAnchorPointsTable).where(eq(mapAnchorPointsTable.id, 1));
      expect(remaining).toEqual([]);
    } finally {
      if (original) {
        await db.insert(mapAnchorPointsTable).values(original).onConflictDoUpdate({
          target: mapAnchorPointsTable.id,
          set: original,
        });
      } else {
        await db.delete(mapAnchorPointsTable).where(eq(mapAnchorPointsTable.id, 1));
      }
    }
  });
});