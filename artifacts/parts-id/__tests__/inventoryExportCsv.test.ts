/**
 * @jest-environment node
 *
 * Unit tests for the inventory CSV export serialization logic.
 * Covers:
 *   - escapeField: double-quote wrapping and RFC 4180 quote escaping
 *   - serializeInventoryToCsv: header, single item, multi-bin, empty
 *     bins, empty barcodes, fields containing commas and quotes
 */

import {
  escapeField,
  serializeInventoryToCsv,
  INVENTORY_CSV_HEADER,
  type CsvInventoryRow,
} from "../utils/exportCsv";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<CsvInventoryRow> = {}): CsvInventoryRow {
  return {
    vendor: "Acme",
    catalog: "PART-001",
    description: "Widget",
    binLocations: ["A1"],
    barcodes: ["123456"],
    ...overrides,
  };
}

/** Split a CSV line into raw (unquoted) field values. */
function parseFields(line: string): string[] {
  return line.split(",").map((f) => f.replace(/^"|"$/g, "").replace(/""/g, '"'));
}

// ── escapeField ───────────────────────────────────────────────────────────

describe("escapeField", () => {
  it("wraps a plain string in double quotes", () => {
    expect(escapeField("hello")).toBe('"hello"');
  });

  it("escapes internal double-quotes by doubling them", () => {
    expect(escapeField('say "hi"')).toBe('"say ""hi"""');
  });

  it("handles an empty string", () => {
    expect(escapeField("")).toBe('""');
  });

  it("escapes multiple double-quotes in the same value", () => {
    expect(escapeField('"a" and "b"')).toBe('"""a"" and ""b"""');
  });

  it("preserves commas inside the quoted field", () => {
    expect(escapeField("a,b,c")).toBe('"a,b,c"');
  });
});

// ── INVENTORY_CSV_HEADER ──────────────────────────────────────────────────

describe("INVENTORY_CSV_HEADER", () => {
  it("contains the expected column names in order", () => {
    expect(INVENTORY_CSV_HEADER).toBe("Vendor,Catalog,Description,BinLocation,Barcodes,OP,OQ");
  });
});

// ── serializeInventoryToCsv ───────────────────────────────────────────────

describe("serializeInventoryToCsv", () => {
  it("starts with the correct header row", () => {
    const csv = serializeInventoryToCsv([makeItem()]);
    expect(csv.split("\n")[0]).toBe(INVENTORY_CSV_HEADER);
  });

  it("produces exactly header + N data rows for N items", () => {
    const csv = serializeInventoryToCsv([makeItem(), makeItem(), makeItem()]);
    expect(csv.split("\n")).toHaveLength(4);
  });

  it("produces only the header row when the items array is empty", () => {
    const csv = serializeInventoryToCsv([]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(INVENTORY_CSV_HEADER);
  });

  // ── single-item export ─────────────────────────────────────────────────

  it("correctly serializes a single item with one bin and one barcode", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ vendor: "Acme", catalog: "P-01", description: "Widget", binLocations: ["A1"], barcodes: ["111"] }),
    ]);
    const fields = parseFields(csv.split("\n")[1]!);
    expect(fields[0]).toBe("Acme");
    expect(fields[1]).toBe("P-01");
    expect(fields[2]).toBe("Widget");
    expect(fields[3]).toBe("A1");
    expect(fields[4]).toBe("111");
  });

  // ── multi-bin item ─────────────────────────────────────────────────────

  it("joins multiple bin locations with semicolons", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ binLocations: ["A1", "B2", "C3"] }),
    ]);
    const fields = parseFields(csv.split("\n")[1]!);
    expect(fields[3]).toBe("A1;B2;C3");
  });

  it("joins multiple barcodes with commas inside the quoted field", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ barcodes: ["111", "222", "333"] }),
    ]);
    const line = csv.split("\n")[1];
    expect(line).toContain('"111,222,333"');
  });

  // ── empty bins array ───────────────────────────────────────────────────

  it("produces a blank bin cell when binLocations is empty", () => {
    const csv = serializeInventoryToCsv([makeItem({ binLocations: [] })]);
    const fields = parseFields(csv.split("\n")[1]!);
    expect(fields[3]).toBe("");
  });

  // ── empty barcodes array ───────────────────────────────────────────────

  it("produces a blank barcodes cell when barcodes is empty", () => {
    const csv = serializeInventoryToCsv([makeItem({ barcodes: [] })]);
    const fields = parseFields(csv.split("\n")[1]!);
    expect(fields[4]).toBe("");
  });

  it("handles an item with both empty bins and empty barcodes", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ binLocations: [], barcodes: [] }),
    ]);
    const fields = parseFields(csv.split("\n")[1]!);
    expect(fields[3]).toBe("");
    expect(fields[4]).toBe("");
  });

  // ── comma / quote escaping ─────────────────────────────────────────────

  it("wraps description containing a comma in double quotes", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ description: "Bolt, 1/4 in" }),
    ]);
    const line = csv.split("\n")[1];
    expect(line).toContain('"Bolt, 1/4 in"');
  });

  it("escapes double-quotes in vendor by doubling them", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ vendor: 'Acme "Corp"' }),
    ]);
    expect(csv).toContain('Acme ""Corp""');
  });

  it("escapes double-quotes in description", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ description: '6" bolt' }),
    ]);
    expect(csv).toContain('6"" bolt');
  });

  it("escapes double-quotes in catalog number", () => {
    const csv = serializeInventoryToCsv([
      makeItem({ catalog: '"SPECIAL"' }),
    ]);
    expect(csv).toContain('""SPECIAL""');
  });

  // ── multi-item ordering ────────────────────────────────────────────────

  it("preserves item order in the output", () => {
    const items = [
      makeItem({ catalog: "FIRST", binLocations: ["X1"] }),
      makeItem({ catalog: "SECOND", binLocations: ["Y2"] }),
    ];
    const lines = serializeInventoryToCsv(items).split("\n");
    expect(parseFields(lines[1]!)[1]).toBe("FIRST");
    expect(parseFields(lines[2]!)[1]).toBe("SECOND");
  });
});
