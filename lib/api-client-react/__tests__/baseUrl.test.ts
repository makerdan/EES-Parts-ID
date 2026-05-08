/**
 * Regression test for the "/api/api/..." double-prefix bug.
 *
 * The OpenAPI spec declares `servers: - url: /api`, so every generated
 * client path already starts with `/api/...`. If a caller sets a base URL
 * that itself ends in `/api`, every request 404s on the API server.
 *
 * This test asserts that, given the recommended `setBaseUrl("https://host")`
 * (no trailing `/api`), a generated client function actually fetches a URL
 * with exactly one `/api/` segment.
 */
import { setBaseUrl, suggestItemDescription, getSuggestItemDescriptionUrl } from '../src';

describe('typed client base URL', () => {
  let fetchMock: jest.Mock;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ description: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    setBaseUrl(null);
    jest.restoreAllMocks();
  });

  it('generated paths already include /api so callers must not append it again', () => {
    expect(getSuggestItemDescriptionUrl(123)).toBe('/api/inventory/123/suggest-description');
  });

  it('produces exactly one /api/ segment when base URL has no /api suffix', async () => {
    setBaseUrl('https://example.com');

    await suggestItemDescription(123);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://example.com/api/inventory/123/suggest-description');
    // Guard against the `/api/api/` regression specifically.
    expect(calledUrl).not.toMatch(/\/api\/api\//);
    // Exactly one occurrence of `/api/` in the path.
    const matches = calledUrl.match(/\/api\//g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('trims trailing slashes on the base URL but preserves the single /api/ segment', async () => {
    setBaseUrl('https://example.com/');

    await suggestItemDescription(7);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://example.com/api/inventory/7/suggest-description');
    expect(calledUrl).not.toMatch(/\/api\/api\//);
  });

  it('documents the doubled-prefix bug: passing a /api-suffixed base URL is wrong', async () => {
    // This test exists to make the failure mode explicit. If anyone re-introduces
    // `setBaseUrl(`${host}/api`)` in app code, the resulting URL will look like
    // `${host}/api/api/...` and every typed-client request will 404.
    setBaseUrl('https://example.com/api');

    await suggestItemDescription(1);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://example.com/api/api/inventory/1/suggest-description');
  });
});
