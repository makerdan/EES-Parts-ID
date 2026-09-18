import { eq, sql } from "drizzle-orm";

import { db, inventoryTable } from "@workspace/db";

const CATALOG = "JEST-ITG-TOTAL-OP-OQ";

afterAll(async () => {
  await db.delete(inventoryTable).where(eq(inventoryTable.catalog, CATALOG));
});

describe("inventory total OP/OQ generated column", () => {
  it("calculates inserts and recalculates after either source value changes", async () => {
    const [inserted] = await db
      .insert(inventoryTable)
      .values({
        vendor: "JEST",
        catalog: CATALOG,
        orderPurchase: 5,
        orderQuantity: 10,
      })
      .returning({
        id: inventoryTable.id,
        totalOpOq: inventoryTable.totalOpOq,
      });

    expect(inserted).toMatchObject({ totalOpOq: 15 });

    const [afterPurchaseUpdate] = await db
      .update(inventoryTable)
      .set({ orderPurchase: 8 })
      .where(eq(inventoryTable.id, inserted!.id))
      .returning({ totalOpOq: inventoryTable.totalOpOq });

    expect(afterPurchaseUpdate).toMatchObject({ totalOpOq: 18 });

    const [afterQuantityUpdate] = await db
      .update(inventoryTable)
      .set({ orderQuantity: 4 })
      .where(eq(inventoryTable.id, inserted!.id))
      .returning({ totalOpOq: inventoryTable.totalOpOq });

    expect(afterQuantityUpdate).toMatchObject({ totalOpOq: 12 });
  });

  it("rejects caller-supplied totals", async () => {
    await expect(
      db.execute(sql`
        INSERT INTO "inventory"
          ("vendor", "catalog", "order_purchase", "order_quantity", "total_op_oq")
        VALUES
          ('JEST', ${`${CATALOG}-EXPLICIT`}, 2, 3, 999)
      `),
    ).rejects.toThrow();
  });
});