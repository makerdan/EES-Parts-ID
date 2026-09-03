/**
 * Unit tests for utils/exportCsv.ts
 *
 * Covers: correct header, field escaping, empty arrays, multi-bin/barcode
 * joining, and multi-row output. No mocks needed — pure function.
 */

import {
  escapeField,
  serializeInventoryToCsv,
  INVENTORY_CSV_HEADER,
  type CsvInventoryRow,
} from "../utils/exportCsv";
import { serializeDashboardToCsv } from "../utils/exportCsv";

// ── escapeField ───────────────────────────────────────────────────────────────

describe("escapeField", () => {
  it("wraps a plain string in double quotes", () => {
    expect(escapeField("EATON")).toBe('"EATON"');
  });

  it("doubles internal double-quote characters", () => {
    expect(escapeField('say "hello"')).toBe('"say ""hello"""');
  });

  it("leaves commas inside the quoted value (no extra escaping needed)", () => {
    expect(escapeField("a,b,c")).toBe('"a,b,c"');
  });

  it("leaves semicolons unchanged", () => {
    expect(escapeField("BIN-1;BIN-2")).toBe('"BIN-1;BIN-2"');
  });

  it("produces an empty quoted cell for an empty string", () => {
    expect(escapeField("")).toBe('""');
  });
});

// ── INVENTORY_CSV_HEADER ──────────────────────────────────────────────────────

describe("INVENTORY_CSV_HEADER", () => {
  it("is the expected column list in order", () => {
    expect(INVENTORY_CSV_HEADER).toBe(
      "Vendor,Catalog,Description,BinLocation,Barcodes",
    );
  });
});

// ── serializeInventoryToCsv ───────────────────────────────────────────────────

describe("serializeInventoryToCsv", () => {
  it("returns only the header row when given an empty array", () => {
    expect(serializeInventoryToCsv([])).toBe(INVENTORY_CSV_HEADER);
  });

  it("produces header + one data row for a single item", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "EATON",
        catalog: "BR120",
        description: "20A 1P Breaker",
        binLocations: ["A1-01"],
        barcodes: ["012345678901"],
      },
    ];
    const csv = serializeInventoryToCsv(items);
    const [header, row] = csv.split("\n");
    expect(header).toBe(INVENTORY_CSV_HEADER);
    expect(row).toBe('"EATON","BR120","20A 1P Breaker","A1-01","012345678901"');
  });

  it("produces blank BinLocation cell when binLocations is empty", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "EATON",
        catalog: "BR120",
        description: "20A 1P Breaker",
        binLocations: [],
        barcodes: [],
      },
    ];
    const csv = serializeInventoryToCsv(items);
    const row = csv.split("\n")[1]!;
    expect(row).toBe('"EATON","BR120","20A 1P Breaker","",""');
  });

  it("produces blank Barcodes cell when barcodes is empty", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "HUBBELL",
        catalog: "HBL5262I",
        description: "Ivory receptacle",
        binLocations: ["B2-03"],
        barcodes: [],
      },
    ];
    const row = serializeInventoryToCsv(items).split("\n")[1]!;
    expect(row).toBe('"HUBBELL","HBL5262I","Ivory receptacle","B2-03",""');
  });

  it("joins multiple bin locations with semicolons", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "SIEMENS",
        catalog: "Q120",
        description: "20A breaker",
        binLocations: ["A1-01", "B3-07", "C5-12"],
        barcodes: [],
      },
    ];
    const row = serializeInventoryToCsv(items).split("\n")[1]!;
    expect(row).toBe('"SIEMENS","Q120","20A breaker","A1-01;B3-07;C5-12",""');
  });

  it("joins multiple barcodes with commas (within the quoted field)", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "LEVITON",
        catalog: "5320",
        description: "Outlet",
        binLocations: [],
        barcodes: ["111111", "222222", "333333"],
      },
    ];
    const row = serializeInventoryToCsv(items).split("\n")[1]!;
    expect(row).toBe('"LEVITON","5320","Outlet","","111111,222222,333333"');
  });

  it("escapes double quotes in field values", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "ACME",
        catalog: "X1",
        description: '3/4" conduit fitting',
        binLocations: [],
        barcodes: [],
      },
    ];
    const row = serializeInventoryToCsv(items).split("\n")[1]!;
    expect(row).toBe('"ACME","X1","3/4"" conduit fitting","",""');
  });

  it("separates multiple rows with newlines", () => {
    const items: CsvInventoryRow[] = [
      { vendor: "A", catalog: "C1", description: "D1", binLocations: [], barcodes: [] },
      { vendor: "B", catalog: "C2", description: "D2", binLocations: [], barcodes: [] },
    ];
    const lines = serializeInventoryToCsv(items).split("\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe(INVENTORY_CSV_HEADER);
    expect(lines[1]).toBe('"A","C1","D1","",""');
    expect(lines[2]).toBe('"B","C2","D2","",""');
  });

  it("round-trips a realistic multi-bin, multi-barcode item", () => {
    const items: CsvInventoryRow[] = [
      {
        vendor: "SQUARE D",
        catalog: "QO120",
        description: "20A 1P QO breaker",
        binLocations: ["E1-04", "E1-05"],
        barcodes: ["785901234567", "785901234568"],
      },
    ];
    const row = serializeInventoryToCsv(items).split("\n")[1]!;
    expect(row).toBe(
      '"SQUARE D","QO120","20A 1P QO breaker","E1-04;E1-05","785901234567,785901234568"',
    );
  });
});

describe("serializeDashboardToCsv", () => {
  it("includes bounded-window privacy metadata and no raw record section", () => {
    const csv = serializeDashboardToCsv({
      generatedAt: "2026-09-01T00:00:00.000Z",
      window: {
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-09-02T00:00:00.000Z",
        days: 30,
      },
      timezone: "UTC",
      privacy: {
        minimumCellCount: 5,
        suppressedValue: "Suppressed",
        uniqueVisitorsAvailable: false,
        aggregateOnly: true,
      },
      ai: { requestsInWindow: null, byFeature: [{ feature: "identify", total: null }] },
      screenViews: {
        viewsInWindow: 5,
        uniqueVisitorsInWindow: null,
        byScreen: [{ screenName: "Search", total: 5 }],
        dailyInWindow: [{ date: "2026-09-01", total: 5 }],
      },
      summary: { inventoryItems: 1, catalogJobsDone: 2, contactMessages: 3 },
    });

    expect(csv).toContain("Window Start");
    expect(csv).toContain("Timezone,\"UTC\"");
    expect(csv).toContain("Privacy Minimum Cell Count,5");
    expect(csv).toContain("Unique Visitor Reporting,\"Disabled\"");
    expect(csv).toContain("Data Scope,Aggregate records only; no raw telemetry records");
    expect(csv).toContain("Requests in Reporting Window,Suppressed");
    expect(csv).not.toContain("visitorHash");
  });
});
