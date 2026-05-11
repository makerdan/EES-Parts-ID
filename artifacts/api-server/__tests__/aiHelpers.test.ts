/**
 * Unit tests for the AI helper utilities (src/utils/aiHelpers.ts).
 *
 * Three pure utility functions are exercised in isolation (no network calls):
 *
 *   buildImageContent   — wraps raw base64 strings in the JPEG data-URI
 *                         prefix expected by the OpenAI Vision API, caps
 *                         output at 2 images, and leaves existing data URIs
 *                         unchanged to prevent double-prefixing.
 *
 *   extractJsonFromText — locates and parses the first JSON object embedded
 *                         in a free-text string (e.g. a raw AI response),
 *                         returning null when no valid object is found.
 *
 *   normalizeAnalysis   — coerces a parsed AI response object (or null on
 *                         parse failure) into a well-typed AnalysisResult
 *                         with safe defaults for every field, including a
 *                         raw-text word-split fallback when parsing fails.
 */
import { buildImageContent, extractJsonFromText, normalizeAnalysis } from '../src/utils/aiHelpers';

// ── buildImageContent ─────────────────────────────────────────────────────────

describe('buildImageContent', () => {
  it('wraps bare base64 strings with the JPEG data URI prefix', () => {
    const result = buildImageContent(['abc123']);
    expect(result[0].image_url.url).toBe('data:image/jpeg;base64,abc123');
  });

  it('leaves an existing data: URI unchanged', () => {
    const uri = 'data:image/png;base64,abc123';
    const result = buildImageContent([uri]);
    expect(result[0].image_url.url).toBe(uri);
  });

  it("returns type 'image_url' for every entry", () => {
    const result = buildImageContent(['a', 'b']);
    expect(result.every((r) => r.type === 'image_url')).toBe(true);
  });

  it('limits output to the first 2 images', () => {
    // The OpenAI Vision API accepts at most 2 images per request; silently
    // dropping extras here prevents an API error at call time.
    const result = buildImageContent(['a', 'b', 'c', 'd']);
    expect(result).toHaveLength(2);
  });

  it('handles an empty array', () => {
    expect(buildImageContent([])).toHaveLength(0);
  });

  it('handles a single image', () => {
    const result = buildImageContent(['only']);
    expect(result).toHaveLength(1);
    expect(result[0].image_url.url).toBe('data:image/jpeg;base64,only');
  });

  it('preserves existing data:image/jpeg;base64, prefix without doubling it', () => {
    // Regression guard: if a caller already prefixes the base64 string with the
    // JPEG data-URI header, a naïve implementation would prepend it a second
    // time, producing an invalid URL like "data:image/jpeg;base64,data:…".
    const uri = 'data:image/jpeg;base64,abc';
    const result = buildImageContent([uri]);
    expect(result[0].image_url.url).toBe(uri);
    expect(result[0].image_url.url).not.toContain('data:image/jpeg;base64,data:');
  });
});

// ── extractJsonFromText ───────────────────────────────────────────────────────

describe('extractJsonFromText', () => {
  it('extracts a JSON object embedded in surrounding text', () => {
    const text = 'Here is the result: {"key": "value"} — done.';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ key: 'value' });
  });

  it('returns null when there is no JSON object in the text', () => {
    expect(extractJsonFromText('no json here')).toBeNull();
  });

  it('returns null for invalid JSON (unclosed brace)', () => {
    expect(extractJsonFromText('{invalid')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJsonFromText('')).toBeNull();
  });

  it('handles nested objects', () => {
    const text = '{"outer":{"inner":1}}';
    const result = extractJsonFromText(text);
    expect(result).toEqual({ outer: { inner: 1 } });
  });

  it('handles multi-line JSON blobs', () => {
    const text = `
      Some preamble text.
      {
        "searchTerms": ["relay", "contactor"],
        "synonyms": []
      }
      Trailing text.
    `;
    const result = extractJsonFromText(text);
    expect(result).toEqual({ searchTerms: ['relay', 'contactor'], synonyms: [] });
  });

  it('returns null for text that only contains an array (no outer object)', () => {
    expect(extractJsonFromText('[1, 2, 3]')).toBeNull();
  });
});

// ── normalizeAnalysis ─────────────────────────────────────────────────────────

describe('normalizeAnalysis', () => {
  it('maps all known fields from a complete parsed object', () => {
    const parsed = {
      searchTerms: ['relay'],
      synonyms: ['contactor'],
      relatedTerms: ['coil'],
      manufacturerVerified: true,
      detectedVendor: 'Eaton',
      summary: 'A relay part.',
    };
    const result = normalizeAnalysis(parsed, '');
    expect(result).toEqual({
      searchTerms: ['relay'],
      synonyms: ['contactor'],
      relatedTerms: ['coil'],
      manufacturerVerified: true,
      detectedVendor: 'Eaton',
      summary: 'A relay part.',
    });
  });

  it('provides safe defaults when parsed is null (raw text fallback)', () => {
    const rawText = 'relay coil contactor motor';
    const result = normalizeAnalysis(null, rawText);
    expect(result.searchTerms).toEqual(expect.any(Array));
    expect(result.searchTerms.length).toBeGreaterThan(0);
    expect(result.synonyms).toEqual([]);
    expect(result.relatedTerms).toEqual([]);
    expect(result.manufacturerVerified).toBe(false);
    expect(result.detectedVendor).toBeNull();
    expect(result.summary).toBeTruthy();
  });

  it('limits raw text fallback searchTerms to 10 words', () => {
    // Caps the term list so a wall-of-text response doesn't flood the search
    // index with hundreds of low-quality keywords.
    const longText = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const result = normalizeAnalysis(null, longText);
    expect(result.searchTerms).toHaveLength(10);
  });

  it('truncates the raw text fallback summary to 200 characters', () => {
    // The UI displays the summary in a compact card; a hard 200-char limit
    // prevents layout overflow when the AI returns a lengthy paragraph.
    const longText = 'a'.repeat(300);
    const result = normalizeAnalysis(null, longText);
    expect(result.summary.length).toBeLessThanOrEqual(200);
  });

  it('defaults non-array searchTerms to an empty array', () => {
    // Guards against the AI returning a comma-separated string instead of an
    // array — a common schema-drift failure mode.
    const result = normalizeAnalysis({ searchTerms: 'not an array' }, '');
    expect(result.searchTerms).toEqual([]);
  });

  it('defaults non-boolean manufacturerVerified to false', () => {
    // The AI sometimes returns "yes"/"no" strings instead of booleans; any
    // non-boolean value must be treated as unverified (false) to be safe.
    const result = normalizeAnalysis({ manufacturerVerified: 'yes' }, '');
    expect(result.manufacturerVerified).toBe(false);
  });

  it('defaults non-string detectedVendor to null', () => {
    // Ensures a numeric or object vendor value doesn't leak into downstream
    // vendor-boost logic that expects a string or null.
    const result = normalizeAnalysis({ detectedVendor: 42 }, '');
    expect(result.detectedVendor).toBeNull();
  });

  it('defaults non-string summary to empty string', () => {
    // Arrays from hallucinated responses must not be joined or stringified;
    // an empty string is the safest fallback for display.
    const result = normalizeAnalysis({ summary: ['not', 'a', 'string'] }, '');
    expect(result.summary).toBe('');
  });

  it('accepts manufacturerVerified: false explicitly', () => {
    // Verifies that the boolean guard uses typeof === 'boolean' rather than
    // a truthiness check, which would incorrectly default false → false (ok)
    // but the test documents the contract explicitly.
    const result = normalizeAnalysis({ manufacturerVerified: false }, '');
    expect(result.manufacturerVerified).toBe(false);
  });

  it('handles an empty parsed object with all defaults', () => {
    const result = normalizeAnalysis({}, '');
    expect(result).toEqual({
      searchTerms: [],
      synonyms: [],
      relatedTerms: [],
      manufacturerVerified: false,
      detectedVendor: null,
      summary: '',
    });
  });
});
