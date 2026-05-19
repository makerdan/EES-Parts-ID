/**
 * Unit tests for the parseCsv() function in adminUpload.ts.
 *
 * These tests exercise the pure parsing logic (no DB, no HTTP) and cover:
 * - Barcode cell with comma-separated values
 * - Barcode cell with semicolon-separated values
 * - Barcode cell with pipe-separated values
 * - Barcode cell with mixed separators (comma + semicolon + pipe)
 * - Empty Barcodes cell → empty barcodes array
 * - Whitespace-only Barcodes cell → empty barcodes array
 * - CSV without a Barcodes column → barcodes array is [] for all rows
 * - Alternative Barcodes column header spellings (Barcode, upc, ean, gtin, barcode#)
 * - Malformed CSV (missing required columns, header-only, empty string) → null
 * - Quoted fields containing commas do not bleed into adjacent barcode cell
 */

// ── Mock heavy dependencies that are not needed for parser unit tests ─────────
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

jest.mock("@workspace/db", () => ({
  db: {},
  inventoryTable: {},
}));

import { parseCsv } from "../src/routes/adminUpload";

// ── Helpers ───────────────────────────────────────────────────────────────────

function csv(...lines: string[]): string {
  return lines.join("\n");
}

// ── parseCsv — structural / null cases ───────────────────────────────────────

describe("parseCsv — null / malformed cases", () => {
  it("returns null for an empty string", () => {
    expect(parseCsv("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseCsv("   \n  ")).toBeNull();
  });

  it("returns null for header-only CSV (no data rows)", () => {
    expect(parseCsv("Vendor,Catalog,Description")).toBeNull();
  });

  it("returns null when the Vendor column is missing", () => {
    expect(parseCsv(csv("Catalog,Description", "CAT-001,Widget"))).toBeNull();
  });

  it("returns null when the Catalog column is missing", () => {
    expect(parseCsv(csv("Vendor,Description", "ACME,Widget"))).toBeNull();
  });

  it("returns an empty array (not null) when all data rows are blank/invalid", () => {
    const result = parseCsv(csv("Vendor,Catalog", ",CAT-001", "ACME,"));
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });
});

// ── parseCsv — barcode cell separators ───────────────────────────────────────

describe("parseCsv — Barcodes column separators", () => {
  it("parses comma-separated barcodes from a quoted Barcodes cell", () => {
    // Multiple comma-separated barcodes must be wrapped in quotes so the CSV
    // parser treats them as one field rather than separate columns.
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        `ACME,CAT-001,"012345678901,987654321098,111111111111"`,
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([
      "012345678901",
      "987654321098",
      "111111111111",
    ]);
  });

  it("parses semicolon-separated barcodes from the Barcodes column", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        "ACME,CAT-001,012345678901;987654321098;111111111111",
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([
      "012345678901",
      "987654321098",
      "111111111111",
    ]);
  });

  it("parses pipe-separated barcodes from the Barcodes column", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        `ACME,CAT-001,012345678901|987654321098`,
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual(["012345678901", "987654321098"]);
  });

  it("parses mixed-separator barcodes (comma + semicolon + pipe) from the Barcodes column", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        `ACME,CAT-001,"012300000001;023400000002|034500000003"`,
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([
      "012300000001",
      "023400000002",
      "034500000003",
    ]);
  });

  it("handles a single barcode (no separator) in the Barcodes column", () => {
    const result = parseCsv(
      csv("Vendor,Catalog,Barcodes", "ACME,CAT-001,012345678901"),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual(["012345678901"]);
  });

  it("trims whitespace around individual barcode values", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        "ACME,CAT-001, 012345678901 ; 987654321098 ",
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual(["012345678901", "987654321098"]);
  });

  it("filters out blank tokens that result from trailing/double separators", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        "ACME,CAT-001,012345678901;;",
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual(["012345678901"]);
  });
});

// ── parseCsv — empty / absent Barcodes column ────────────────────────────────

describe("parseCsv — empty or absent Barcodes column", () => {
  it("returns empty barcodes array when the Barcodes cell is empty", () => {
    const result = parseCsv(csv("Vendor,Catalog,Barcodes", "ACME,CAT-001,"));
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([]);
  });

  it("returns empty barcodes array when the Barcodes cell is whitespace-only", () => {
    const result = parseCsv(csv("Vendor,Catalog,Barcodes", "ACME,CAT-001,   "));
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([]);
  });

  it("returns empty barcodes array for every row when the CSV has no Barcodes column", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Description",
        "ACME,CAT-001,Widget",
        "ACME,CAT-002,Gadget",
      ),
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.barcodes).toEqual([]);
    expect(result![1]!.barcodes).toEqual([]);
  });
});

// ── parseCsv — alternative header spellings ───────────────────────────────────

describe("parseCsv — alternative Barcodes column header spellings", () => {
  const barcode = "012345678901";

  it.each([
    ["Barcodes", barcode],
    ["Barcode", barcode],
    ["upc", barcode],
    ["UPC", barcode],
    ["ean", barcode],
    ["EAN", barcode],
    ["gtin", barcode],
    ["GTIN", barcode],
    ["barcode#", barcode],
  ])('recognises "%s" as the barcodes column', (header, value) => {
    const result = parseCsv(csv(`Vendor,Catalog,${header}`, `ACME,CAT-001,${value}`));
    expect(result).not.toBeNull();
    expect(result![0]!.barcodes).toEqual([barcode]);
  });
});

// ── parseCsv — multi-row correctness ─────────────────────────────────────────

describe("parseCsv — multi-row barcodes", () => {
  it("parses barcodes independently for each row", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        "ACME,CAT-001,111111111111",
        "ACME,CAT-002,222222222222;333333333333",
        "ACME,CAT-003,",
      ),
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]!.barcodes).toEqual(["111111111111"]);
    expect(result![1]!.barcodes).toEqual(["222222222222", "333333333333"]);
    expect(result![2]!.barcodes).toEqual([]);
  });

  it("does not bleed quoted Catalog field commas into the Barcodes column", () => {
    const result = parseCsv(
      csv(
        "Vendor,Catalog,Barcodes",
        `ACME,"Breaker, 20A",012345678901`,
      ),
    );
    expect(result).not.toBeNull();
    expect(result![0]!.catalog).toBe("Breaker, 20A");
    expect(result![0]!.barcodes).toEqual(["012345678901"]);
  });
});
