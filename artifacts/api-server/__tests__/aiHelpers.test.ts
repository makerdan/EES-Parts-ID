import {
  buildImageContent,
  extractJsonFromText,
  normalizeAnalysis,
} from "../src/utils/aiHelpers";

// ── buildImageContent ─────────────────────────────────────────────────────────

describe("buildImageContent", () => {
  it("wraps bare base64 strings with the JPEG data URI prefix", () => {
    const result = buildImageContent(["abc123"]);
    expect(result[0].image_url.url).toBe("data:image/jpeg;base64,abc123");
  });

  it("leaves an existing data: URI unchanged", () => {
    const uri = "data:image/png;base64,abc123";
    const result = buildImageContent([uri]);
    expect(result[0].image_url.url).toBe(uri);
  });

  it("returns type 'image_url' for every entry", () => {
    const result = buildImageContent(["a", "b"]);
    expect(result.every(r => r.type === "image_url")).toBe(true);
  });

  it("limits output to the first 4 images", () => {
    const result = buildImageContent(["a", "b", "c", "d", "e"]);
    expect(result).toHaveLength(4);
  });

  it("produces exactly 4 content blocks from a 4-image input (regression: previously truncated to 2)", () => {
    const images = ["img1", "img2", "img3", "img4"];
    const result = buildImageContent(images);
    expect(result).toHaveLength(4);
    expect(result[2].image_url.url).toBe("data:image/jpeg;base64,img3");
    expect(result[3].image_url.url).toBe("data:image/jpeg;base64,img4");
  });

  it("handles an empty array", () => {
    expect(buildImageContent([])).toHaveLength(0);
  });

  it("handles a single image", () => {
    const result = buildImageContent(["only"]);
    expect(result).toHaveLength(1);
    expect(result[0].image_url.url).toBe("data:image/jpeg;base64,only");
  });

  it("preserves existing data:image/jpeg;base64, prefix without doubling it", () => {
    const uri = "data:image/jpeg;base64,abc";
    const result = buildImageContent([uri]);
    expect(result[0].image_url.url).toBe(uri);
    expect(result[0].image_url.url).not.toContain("data:image/jpeg;base64,data:");
  });
});

// ── extractJsonFromText ───────────────────────────────────────────────────────

describe("extractJsonFromText", () => {
  it("extracts a JSON object embedded in surrounding text", () => {
    const text = 'Here is the result: {"key": "value"} — done.';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ key: "value" });
  });

  it("returns null when there is no JSON object in the text", () => {
    expect(extractJsonFromText("no json here")).toBeNull();
  });

  it("returns null for invalid JSON (unclosed brace)", () => {
    expect(extractJsonFromText("{invalid")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractJsonFromText("")).toBeNull();
  });

  it("handles nested objects", () => {
    const text = '{"outer":{"inner":1}}';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ outer: { inner: 1 } });
  });

  it("handles multi-line JSON blobs", () => {
    const text = `
      Some preamble text.
      {
        "searchTerms": ["relay", "contactor"],
        "synonyms": []
      }
      Trailing text.
    `;
    const result = extractJsonFromText(text);
    expect(result).toEqual({ searchTerms: ["relay", "contactor"], synonyms: [] });
  });

  it("returns null for text that only contains an array (no outer object)", () => {
    expect(extractJsonFromText("[1, 2, 3]")).toBeNull();
  });
});

// ── normalizeAnalysis ─────────────────────────────────────────────────────────

describe("normalizeAnalysis", () => {
  it("maps all known fields from a complete parsed object", () => {
    const parsed = {
      searchTerms: ["relay"],
      synonyms: ["contactor"],
      relatedTerms: ["coil"],
      manufacturerVerified: true,
      detectedVendor: "Eaton",
      summary: "A relay part.",
    };
    const result = normalizeAnalysis(parsed, "");
    expect(result).toEqual({
      partNumbers: [],
      searchTerms: ["relay"],
      synonyms: ["contactor"],
      relatedTerms: ["coil"],
      manufacturerVerified: true,
      detectedVendor: "Eaton",
      summary: "A relay part.",
    });
  });

  it("returns empty searchTerms and synonyms when parsed is null (non-JSON AI response)", () => {
    const rawText = "relay coil contactor motor";
    const result = normalizeAnalysis(null, rawText);
    expect(result.searchTerms).toEqual([]);
    expect(result.synonyms).toEqual([]);
    expect(result.relatedTerms).toEqual([]);
    expect(result.manufacturerVerified).toBe(false);
    expect(result.detectedVendor).toBeNull();
    expect(result.summary).toBe(rawText);
  });

  it("preserves the raw AI text as the summary (up to 200 chars) when parsed is null", () => {
    const longText = "a".repeat(300);
    const result = normalizeAnalysis(null, longText);
    expect(result.searchTerms).toHaveLength(0);
    expect(result.summary).toHaveLength(200);
  });

  it("defaults non-array searchTerms to an empty array", () => {
    const result = normalizeAnalysis({ searchTerms: "not an array" }, "");
    expect(result.searchTerms).toEqual([]);
  });

  it("defaults non-boolean manufacturerVerified to false", () => {
    const result = normalizeAnalysis({ manufacturerVerified: "yes" }, "");
    expect(result.manufacturerVerified).toBe(false);
  });

  it("defaults non-string detectedVendor to null", () => {
    const result = normalizeAnalysis({ detectedVendor: 42 }, "");
    expect(result.detectedVendor).toBeNull();
  });

  it("defaults non-string summary to empty string", () => {
    const result = normalizeAnalysis({ summary: ["not", "a", "string"] }, "");
    expect(result.summary).toBe("");
  });

  it("accepts manufacturerVerified: false explicitly", () => {
    const result = normalizeAnalysis({ manufacturerVerified: false }, "");
    expect(result.manufacturerVerified).toBe(false);
  });

  it("handles an empty parsed object with all defaults", () => {
    const result = normalizeAnalysis({}, "");
    expect(result).toEqual({
      partNumbers: [],
      searchTerms: [],
      synonyms: [],
      relatedTerms: [],
      manufacturerVerified: false,
      detectedVendor: null,
      summary: "",
    });
  });
});
