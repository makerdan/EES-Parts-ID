export interface CsvInventoryRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: string[];
  barcodes: string[];
}

export const INVENTORY_CSV_HEADER =
  "Vendor,Catalog,Description,BinLocation,Barcodes";

export function escapeField(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function serializeInventoryToCsv(items: CsvInventoryRow[]): string {
  const lines = items.map((item) => {
    const bin = item.binLocations.join(";");
    const barcodes = item.barcodes.join(",");
    return [item.vendor, item.catalog, item.description, bin, barcodes]
      .map(escapeField)
      .join(",");
  });
  return [INVENTORY_CSV_HEADER, ...lines].join("\n");
}
