export interface CsvInventoryRow {
  vendor: string;
  catalog: string;
  description: string;
  binLocations: Array<string>;
  barcodes: Array<string>;
  op?: number;
  oq?: number;
}

export const INVENTORY_CSV_HEADER =
  "Vendor,Catalog,Description,BinLocation,Barcodes,OP,OQ";

export function escapeField(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function serializeInventoryToCsv(items: Array<CsvInventoryRow>): string {
  const lines = items.map((item) => {
    const bin = item.binLocations.join(";");
    const barcodes = item.barcodes.join(",");
    return [item.vendor, item.catalog, item.description, bin, barcodes, String(item.op ?? 0), String(item.oq ?? 0)]
      .map(escapeField)
      .join(",");
  });
  return [INVENTORY_CSV_HEADER, ...lines].join("\n");
}

export interface DashboardStats {
  generatedAt?: string;
  window?: {
    start: string;
    end: string;
    days: number;
  };
  timezone?: string;
  privacy?: {
    minimumCellCount: number;
    suppressedValue: string;
    uniqueVisitorsAvailable: boolean;
    aggregateOnly: boolean;
  };
  ai: {
    requestsInWindow?: number | null;
    byFeature: Array<{ feature: string; total: number | null }>;
  };
  screenViews: {
    viewsInWindow?: number | null;
    uniqueVisitorsInWindow?: number | null;
    byScreen: Array<{ screenName: string; total: number }>;
    dailyInWindow?: Array<{ date: string; total: number }>;
  };
  summary: {
    inventoryItems: number;
    catalogJobsDone: number;
    contactMessages: number;
  };
}

export function serializeDashboardToCsv(stats: DashboardStats): string {
  const sections: Array<string> = [];

  sections.push("SUPPORT ANALYTICS EXPORT");
  sections.push("Metadata,Value");
  sections.push(`Generated At,${escapeField(stats.generatedAt ?? "Unknown")}`);
  sections.push(`Window Start,${escapeField(stats.window?.start ?? "Unknown")}`);
  sections.push(`Window End,${escapeField(stats.window?.end ?? "Unknown")}`);
  sections.push(`Window Days,${stats.window?.days ?? "Unknown"}`);
  sections.push(`Timezone,${escapeField(stats.timezone ?? "Unknown")}`);
  sections.push(
    `Privacy Minimum Cell Count,${stats.privacy?.minimumCellCount ?? "Unknown"}`,
  );
  sections.push(
    `Unique Visitor Reporting,${escapeField(
      stats.privacy?.uniqueVisitorsAvailable ? "Enabled" : "Disabled",
    )}`,
  );
  sections.push("Data Scope,Aggregate records only; no raw telemetry records");

  sections.push("SUMMARY");
  sections.push("Metric,Value");
  sections.push(`Inventory Items,${stats.summary.inventoryItems}`);
  sections.push(`Catalog Jobs Done,${stats.summary.catalogJobsDone}`);
  sections.push(`Contact Messages,${stats.summary.contactMessages}`);

  sections.push("");
  sections.push("AI USAGE");
  sections.push("Metric,Value");
  sections.push(`Requests in Reporting Window,${stats.ai.requestsInWindow ?? "Suppressed"}`);

  sections.push("");
  sections.push("AI Usage by Feature");
  sections.push("Feature,Requests");
  for (const row of stats.ai.byFeature) {
    const label = row.feature === "identify" ? "Photo ID" : "Reference Assistant";
    sections.push(`${escapeField(label)},${row.total ?? "Suppressed"}`);
  }

  sections.push("");
  sections.push("SCREEN VIEWS");
  sections.push("Metric,Value");
  sections.push(`Views in Reporting Window,${stats.screenViews.viewsInWindow ?? "Suppressed"}`);
  sections.push(
    `Unique Visitors in Reporting Window,${stats.screenViews.uniqueVisitorsInWindow ?? "Suppressed"}`,
  );

  sections.push("");
  sections.push("Screen Views by Screen");
  sections.push("Screen,Views");
  for (const row of stats.screenViews.byScreen) {
    sections.push(`${escapeField(row.screenName)},${row.total}`);
  }

  sections.push("");
  sections.push("Daily Views — Reporting Window");
  sections.push("Date,Views");
  for (const row of stats.screenViews.dailyInWindow ?? []) {
    sections.push(`${escapeField(row.date)},${row.total ?? "Suppressed"}`);
  }

  return sections.join("\n");
}
