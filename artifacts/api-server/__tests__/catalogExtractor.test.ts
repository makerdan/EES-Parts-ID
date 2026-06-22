/**
 * Tests for catalogExtractor.ts
 *
 * OpenAI is mocked – no live API call is made.
 * Covers:
 *   - Output shape validation (integration tests)
 *   - Field normalisation (confidence clamping, description truncation, etc.)
 *   - Image input handling (base64 encoding, limit of 4 images)
 *   - End-to-end fixture tests using known catalog-page text snippets
 */

// ── Mock OpenAI BEFORE module is imported ────────────────────────────────────
const mockCreate = jest.fn();

jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { CatalogAiError, extractCatalogPage } from "../src/utils/catalogExtractor";

/** 20 MB in bytes — the total inline image cap for the Gemini Poe bots. */
const GEMINI_TOTAL_LIMIT = 20 * 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpenAIResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Realistic single-page text excerpt from an Eaton BR-series catalog page. */
const EATON_BR_PAGE_TEXT = `
EATON BR SERIES CIRCUIT BREAKERS
Product Family: Type BR – Residential Miniature Circuit Breakers

Cat No.   Description
BR120     Single-Pole 20A 120/240V Thermal Magnetic Circuit Breaker
BR220     Two-Pole 20A 240V Thermal Magnetic Circuit Breaker
BR230     Two-Pole 30A 240V Thermal Magnetic Circuit Breaker

All breakers are UL 489 listed and comply with NEC requirements.
`.trim();

/** Typical table-of-contents page that should yield no parts. */
const TOC_PAGE_TEXT = `
TABLE OF CONTENTS

Section 1: Circuit Breakers ......... 5
Section 2: Load Centers ............. 12
Section 3: Panelboards .............. 20
Section 4: Safety Switches .......... 35
`.trim();

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Output shape
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCatalogPage – output shape", () => {
  it("returns a well-formed CatalogEntry array for a valid GPT-4o response", async () => {
    const entries = [
      { catalogNumber: "BR120", description: "Single-Pole 20A Breaker", confidence: 0.98, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR220", description: "Two-Pole 20A Breaker", confidence: 0.95, hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("page text", [], "Eaton");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      catalogNumber: "BR120",
      description: "Single-Pole 20A Breaker",
      hasPartImage: false,
      imageRegion: null,
    });
    expect(typeof result[0].confidence).toBe("number");
    expect(result[1].catalogNumber).toBe("BR220");
  });

  it("returns [] immediately when both pageText and pageImages are empty (no AI call)", async () => {
    const result = await extractCatalogPage("", [], "Eaton");

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns [] when pageText is only whitespace and no images are provided", async () => {
    const result = await extractCatalogPage("   \n   ", [], "Eaton");

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns [] when GPT-4o responds with an empty array (non-part page)", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    const result = await extractCatalogPage("cover page text", [], "Eaton");

    expect(result).toEqual([]);
  });

  it("returns [] when the GPT-4o response contains no JSON array", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("No parts found on this page."));

    const result = await extractCatalogPage("some page text", [], "Eaton");

    expect(result).toEqual([]);
  });

  it("returns [] and does not throw when GPT-4o throws an error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("rate limit exceeded"));

    const result = await extractCatalogPage("some text", [], "Eaton");

    expect(result).toEqual([]);
  });

  it("filters out entries missing a catalogNumber", async () => {
    const entries = [
      { catalogNumber: "BR120", description: "Good entry", confidence: 0.9, hasPartImage: false, imageRegion: null },
      { description: "Missing catalog number", confidence: 0.7, hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result).toHaveLength(1);
    expect(result[0].catalogNumber).toBe("BR120");
  });

  it("filters out entries missing a confidence value", async () => {
    const entries = [
      { catalogNumber: "BR120", description: "Valid", confidence: 0.9, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR220", description: "No confidence field", hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result).toHaveLength(1);
    expect(result[0].catalogNumber).toBe("BR120");
  });

  it("filters out entries with empty catalog numbers after trimming", async () => {
    const entries = [
      { catalogNumber: "   ", description: "Whitespace only", confidence: 0.8, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR130", description: "Valid", confidence: 0.9, hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result).toHaveLength(1);
    expect(result[0].catalogNumber).toBe("BR130");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Field normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCatalogPage – field normalisation", () => {
  it("trims whitespace from catalogNumber and description", async () => {
    const entries = [{
      catalogNumber: "  BR120  ",
      description: "  20A Breaker  ",
      confidence: 0.9,
      hasPartImage: false,
      imageRegion: null,
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].catalogNumber).toBe("BR120");
    expect(result[0].description).toBe("20A Breaker");
  });

  it("clamps confidence above 1.0 down to 1.0", async () => {
    const entries = [{
      catalogNumber: "BR120", description: "Breaker", confidence: 1.5,
      hasPartImage: false, imageRegion: null,
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].confidence).toBe(1.0);
  });

  it("clamps confidence below 0.0 up to 0.0", async () => {
    const entries = [{
      catalogNumber: "BR220", description: "Breaker", confidence: -0.3,
      hasPartImage: false, imageRegion: null,
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].confidence).toBe(0.0);
  });

  it("truncates description to 200 characters", async () => {
    const entries = [{
      catalogNumber: "BR120",
      description: "X".repeat(300),
      confidence: 0.9,
      hasPartImage: false,
      imageRegion: null,
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].description.length).toBe(200);
  });

  it("populates imageRegion when hasPartImage is true and region has valid numeric fields", async () => {
    const entries = [{
      catalogNumber: "BR120",
      description: "Breaker with image",
      confidence: 0.9,
      hasPartImage: true,
      imageRegion: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].hasPartImage).toBe(true);
    expect(result[0].imageRegion).toEqual({ x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
  });

  it("clamps imageRegion coordinates that fall outside [0, 1]", async () => {
    const entries = [{
      catalogNumber: "BR120",
      description: "Breaker",
      confidence: 0.9,
      hasPartImage: true,
      imageRegion: { x: -0.5, y: 1.8, width: 2.0, height: -0.1 },
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    const region = result[0].imageRegion!;
    expect(region.x).toBe(0);
    expect(region.y).toBe(1);
    expect(region.width).toBe(1);
    expect(region.height).toBe(0);
  });

  it("sets imageRegion to null when hasPartImage is false even if region data is present", async () => {
    const entries = [{
      catalogNumber: "BR120",
      description: "Breaker",
      confidence: 0.9,
      hasPartImage: false,
      imageRegion: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].imageRegion).toBeNull();
  });

  it("sets imageRegion to null when the region object has non-numeric fields", async () => {
    const entries = [{
      catalogNumber: "BR120",
      description: "Breaker",
      confidence: 0.9,
      hasPartImage: true,
      imageRegion: { x: "left", y: "top", width: "half", height: "quarter" },
    }];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(entries)));

    const result = await extractCatalogPage("text", [], "Eaton");

    expect(result[0].imageRegion).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Image input handling
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCatalogPage – image input handling", () => {
  it("calls the AI when only images are provided and no page text exists", async () => {
    const imgBuf = Buffer.alloc(16, 0xff);
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    const result = await extractCatalogPage("", [imgBuf], "Eaton");

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("encodes page images as PNG base64 data URIs in the request", async () => {
    const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage("", [imgBuf], "Hubbell");

    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    const imageEntry = userContent.find((c) => c.type === "image_url");
    expect(imageEntry).toBeDefined();
    expect(imageEntry!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });

  it("limits page images sent to GPT-4o to at most 4", async () => {
    const images = Array.from({ length: 6 }, () => Buffer.alloc(8, 0x01));
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage("", images, "Eaton");

    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string }>;
    const imageCount = userContent.filter((c) => c.type === "image_url").length;
    expect(imageCount).toBe(4);
  });

  it("includes page text alongside images when both are provided", async () => {
    const imgBuf = Buffer.alloc(8, 0x01);
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage("some catalog text", [imgBuf], "Eaton");

    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; text?: string }>;
    const textEntry = userContent.find((c) => c.type === "text");
    const imageEntry = userContent.find((c) => c.type === "image_url");
    expect(textEntry).toBeDefined();
    expect(imageEntry).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end fixture: known-good catalog page snippets
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCatalogPage – end-to-end fixture (Eaton BR series)", () => {
  it("extracts all three BR-series part numbers from the known catalog page fixture", async () => {
    const expectedEntries = [
      { catalogNumber: "BR120", description: "Single-Pole 20A 120/240V Thermal Magnetic Circuit Breaker", confidence: 0.97, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR220", description: "Two-Pole 20A 240V Thermal Magnetic Circuit Breaker", confidence: 0.97, hasPartImage: false, imageRegion: null },
      { catalogNumber: "BR230", description: "Two-Pole 30A 240V Thermal Magnetic Circuit Breaker", confidence: 0.97, hasPartImage: false, imageRegion: null },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(expectedEntries)));

    const result = await extractCatalogPage(EATON_BR_PAGE_TEXT, [], "Eaton");

    expect(result).toHaveLength(3);
    const catalogNumbers = result.map((e) => e.catalogNumber);
    expect(catalogNumbers).toContain("BR120");
    expect(catalogNumbers).toContain("BR220");
    expect(catalogNumbers).toContain("BR230");
  });

  it("sends the vendor name and page text to GPT-4o in the user message", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage(EATON_BR_PAGE_TEXT, [], "Eaton");

    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; text?: string }>;
    const textEntry = userContent.find((c) => c.type === "text");
    expect(textEntry?.text).toContain("Eaton");
    expect(textEntry?.text).toContain("BR120");
  });

  it("uses gpt-4o as the model for catalog page extraction", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage(EATON_BR_PAGE_TEXT, [], "Eaton");

    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4o");
  });

  it("returns an empty array for a non-part page (table of contents fixture)", async () => {
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    const result = await extractCatalogPage(TOC_PAGE_TEXT, [], "Eaton");

    expect(result).toEqual([]);
  });

  it("extracts the JSON array even when GPT-4o wraps it in a markdown code fence", async () => {
    // GPT-4o sometimes returns ```json ... ``` fences despite instructions
    const fencedResponse = '```json\n[{"catalogNumber":"BR150","description":"150A Breaker","confidence":0.88,"hasPartImage":false,"imageRegion":null}]\n```';
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(fencedResponse));

    const result = await extractCatalogPage(EATON_BR_PAGE_TEXT, [], "Eaton");

    expect(result).toHaveLength(1);
    expect(result[0].catalogNumber).toBe("BR150");
  });

  it("handles a multi-entry response mixing parts that have images and parts that do not", async () => {
    const mixed = [
      {
        catalogNumber: "BR120",
        description: "20A Breaker",
        confidence: 0.95,
        hasPartImage: true,
        imageRegion: { x: 0.05, y: 0.1, width: 0.3, height: 0.25 },
      },
      {
        catalogNumber: "BR220",
        description: "Two-Pole 20A Breaker",
        confidence: 0.93,
        hasPartImage: false,
        imageRegion: null,
      },
    ];
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse(JSON.stringify(mixed)));

    const result = await extractCatalogPage(EATON_BR_PAGE_TEXT, [], "Eaton");

    expect(result).toHaveLength(2);
    expect(result[0].hasPartImage).toBe(true);
    expect(result[0].imageRegion).not.toBeNull();
    expect(result[1].hasPartImage).toBe(false);
    expect(result[1].imageRegion).toBeNull();
  });

  it("truncates page text sent to the AI at 3000 characters when the page is very long", async () => {
    const longPageText = "Part XYZ-001 Widget ".repeat(200); // >> 3000 chars
    mockCreate.mockResolvedValueOnce(makeOpenAIResponse("[]"));

    await extractCatalogPage(longPageText, [], "Eaton");

    const callArg = mockCreate.mock.calls[0][0];
    const userContent = callArg.messages[1].content as Array<{ type: string; text?: string }>;
    const textEntry = userContent.find((c) => c.type === "text");
    // The text prompt includes "Vendor: Eaton\nPage text:\n" prefix + up to 3000 chars of page text
    expect(textEntry!.text!.length).toBeLessThanOrEqual("Vendor: Eaton\nPage text:\n".length + 3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractCatalogPage — payload size guard (ai_payload_too_large)
// ─────────────────────────────────────────────────────────────────────────────

describe("extractCatalogPage — payload size guard", () => {
  it("throws CatalogAiError with code ai_payload_too_large when total buffer size exceeds 20 MB", async () => {
    // Two 11 MB buffers → 22 MB total — over the 20 MB Gemini inline limit.
    const buf = Buffer.alloc(11 * 1024 * 1024, 0x01);

    await expect(extractCatalogPage("some text", [buf, buf], "Eaton"))
      .rejects.toBeInstanceOf(CatalogAiError);

    await expect(extractCatalogPage("some text", [buf, buf], "Eaton"))
      .rejects.toMatchObject({ code: "ai_payload_too_large" });
  });

  it("does not call the AI when the payload size guard fires", async () => {
    const buf = Buffer.alloc(11 * 1024 * 1024, 0x02);

    await expect(extractCatalogPage("some text", [buf, buf], "Eaton")).rejects.toBeInstanceOf(CatalogAiError);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("throws with a message mentioning the size and limit in MB", async () => {
    const buf = Buffer.alloc(11 * 1024 * 1024, 0x03);

    let caught: unknown;
    try {
      await extractCatalogPage("some text", [buf, buf], "Eaton");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CatalogAiError);
    const error = caught as CatalogAiError;
    expect(error.originalMessage).toMatch(/MB/);
    expect(error.originalMessage).toMatch(/limit/i);
  });

  it("does NOT throw ai_payload_too_large when total buffer is exactly at the 20 MB limit (boundary — inclusive)", async () => {
    // The guard uses strict `>`, so total === limit must pass the check.
    // Two 10 MB buffers = exactly 20 MB total.  The guard should not fire;
    // the call may fail later with ai_error (no live AI in test env), but
    // must not be rejected as ai_payload_too_large.
    const TEN_MB = 10 * 1024 * 1024;
    const buf = Buffer.alloc(TEN_MB, 0x04);

    try {
      await extractCatalogPage("some text", [buf, buf], "Eaton");
    } catch (err) {
      if (err instanceof CatalogAiError) {
        expect(err.code).not.toBe("ai_payload_too_large");
      }
      // Any other throw (network, ai_error, etc.) is fine — the guard did not fire.
    }
  });
});
