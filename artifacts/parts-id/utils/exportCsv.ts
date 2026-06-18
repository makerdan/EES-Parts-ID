export interface CsvInventoryRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: Array<string>;
  barcodes: Array<string>;
}

export const INVENTORY_CSV_HEADER =
  "Vendor,Catalog,Description,BinLocation,Barcodes";

export function escapeField(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function serializeInventoryToCsv(items: Array<CsvInventoryRow>): string {
  const lines = items.map((item) => {
    const bin = item.binLocations.join(";");
    const barcodes = item.barcodes.join(",");
    return [item.vendor, item.catalog, item.description, bin, barcodes]
      .map(escapeField)
      .join(",");
  });
  return [INVENTORY_CSV_HEADER, ...lines].join("\n");
}

export interface DashboardStats {
  ai: {
    totalAllTime: number;
    totalThisMonth: number;
    byFeature: Array<{ feature: string; total: number }>;
  };
  screenViews: {
    totalAllTime: number;
    uniqueVisitorsToday: number;
    byScreen: Array<{ screenName: string; total: number }>;
    dailyLast30Days: Array<{ date: string; total: number }>;
  };
  summary: {
    inventoryItems: number;
    catalogJobsDone: number;
    contactMessages: number;
  };
}

export function serializeDashboardToCsv(stats: DashboardStats): string {
  const sections: Array<string> = [];

  sections.push("SUMMARY");
  sections.push("Metric,Value");
  sections.push(`Inventory Items,${stats.summary.inventoryItems}`);
  sections.push(`Catalog Jobs Done,${stats.summary.catalogJobsDone}`);
  sections.push(`Contact Messages,${stats.summary.contactMessages}`);

  sections.push("");
  sections.push("AI USAGE");
  sections.push("Metric,Value");
  sections.push(`Total All Time,${stats.ai.totalAllTime}`);
  sections.push(`Total This Month,${stats.ai.totalThisMonth}`);

  sections.push("");
  sections.push("AI Usage by Feature");
  sections.push("Feature,Requests");
  for (const row of stats.ai.byFeature) {
    const label = row.feature === "identify" ? "Photo ID" : "Reference Assistant";
    sections.push(`${escapeField(label)},${row.total}`);
  }

  sections.push("");
  sections.push("SCREEN VIEWS");
  sections.push("Metric,Value");
  sections.push(`Total All Time,${stats.screenViews.totalAllTime}`);
  sections.push(`Unique Visitors Today,${stats.screenViews.uniqueVisitorsToday}`);

  sections.push("");
  sections.push("Screen Views by Screen");
  sections.push("Screen,Views");
  for (const row of stats.screenViews.byScreen) {
    sections.push(`${escapeField(row.screenName)},${row.total}`);
  }

  sections.push("");
  sections.push("Daily Views — Last 30 Days");
  sections.push("Date,Views");
  for (const row of stats.screenViews.dailyLast30Days) {
    sections.push(`${escapeField(row.date)},${row.total}`);
  }

  return sections.join("\n");
}
