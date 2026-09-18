import { type InsertInventory,inventoryTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function restoreInventoryRowsLocked(
  tx: Parameters<Parameters<typeof import("@workspace/db").db.transaction>[0]>[0],
  stored: Array<Record<string, unknown>>,
): Promise<number> {
  await tx.delete(inventoryTable);
  const rows: Array<InsertInventory> = stored.map((row) => ({
    id: Number(row.id),
    vendor: String(row.vendor),
    catalog: String(row.catalog),
    orderPurchase: Number(row.orderPurchase),
    orderQuantity: Number(row.orderQuantity),
    description: String(row.description),
    binLocations: row.binLocations as Array<string>,
    aiKeywords: row.aiKeywords as Array<string>,
    pinnedKeywords: row.pinnedKeywords as Array<string>,
    barcodes: row.barcodes as Array<string>,
    enrichedAt: row.enrichedAt ? new Date(String(row.enrichedAt)) : null,
    imageUrl: row.imageUrl ? String(row.imageUrl) : null,
    thumbnailUrl: row.thumbnailUrl ? String(row.thumbnailUrl) : null,
    imageUrl2: row.imageUrl2 ? String(row.imageUrl2) : null,
    thumbnailUrl2: row.thumbnailUrl2 ? String(row.thumbnailUrl2) : null,
    imageSource: row.imageSource ? String(row.imageSource) : null,
    imageConfidence: row.imageConfidence == null ? null : Number(row.imageConfidence),
    previousDescription: row.previousDescription ? String(row.previousDescription) : null,
    catalogPdfJobId: row.catalogPdfJobId == null ? null : Number(row.catalogPdfJobId),
    expandedDescription: row.expandedDescription ? String(row.expandedDescription) : null,
    size: row.size ? String(row.size) : null,
    dimensions: row.dimensions as InsertInventory["dimensions"],
    createdAt: row.createdAt ? new Date(String(row.createdAt)) : new Date(),
    updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : new Date(),
  }));
  if (rows.length) await tx.insert(inventoryTable).values(rows);
  await tx.execute(sql`select setval(pg_get_serial_sequence('inventory', 'id'), coalesce((select max(id) from inventory), 1), true)`);
  const count = await tx.select({ count: sql<number>`count(*)` }).from(inventoryTable);
  if (Number(count[0]?.count ?? 0) !== rows.length) throw new Error("Restored inventory row count verification failed");
  const generated = await tx.select({
    orderPurchase: inventoryTable.orderPurchase,
    orderQuantity: inventoryTable.orderQuantity,
    totalOpOq: inventoryTable.totalOpOq,
  }).from(inventoryTable);
  if (generated.some((row) => row.totalOpOq !== row.orderPurchase + row.orderQuantity)) {
    throw new Error("Restored generated totalOpOq verification failed");
  }
  return rows.length;
}