/**
 * @jest-environment jsdom
 *
 * Unit tests for useMapAnchors — MFA error path coverage.
 *
 * Covered:
 *   - upsertAnchor: 200 OK → { ok: true }
 *   - upsertAnchor: 403 MFA_REQUIRED → { ok: false, mfaRequired: true }
 *   - upsertAnchor: 5xx server error → { ok: false } (no mfaRequired flag)
 *   - deleteAnchor: 403 MFA_REQUIRED → { ok: false, mfaRequired: true }
 *   - refetch (GET): 403 MFA_REQUIRED → mfaRequired: true, error: false
 */

// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderHook, act } from "@testing-library/react";
import { useMapAnchors, type UpsertAnchorPayload } from "../hooks/useMapAnchors";

// ── apiBase mock ──────────────────────────────────────────────────────────────
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001" }));

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_TOKEN = "test-admin-token";
const BASE = "http://localhost:3001";

const VALID_PAYLOAD: UpsertAnchorPayload = {
  name: "Entrance",
  svgX: 100,
  svgY: 200,
  worldX: 10,
  worldY: 20,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response);
}

const flushPromises = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

// ── Per-test setup ────────────────────────────────────────────────────────────

let mockFetch: jest.Mock;

beforeEach(() => {
  // Default: GET /admin/map-anchors returns empty list
  mockFetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (init?.method === "PUT" || init?.method === "DELETE") {
      // Tests override this per-case — default: 200 OK
      return makeJsonResponse(200, {});
    }
    return makeJsonResponse(200, { anchors: [] });
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// upsertAnchor
// =============================================================================

describe("upsertAnchor — return values", () => {
  it("returns { ok: true } when the server responds with 200", async () => {
    // Override PUT to return 200
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return makeJsonResponse(200, {});
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises(); // let initial GET settle

    let putResult!: Awaited<ReturnType<typeof result.current.upsertAnchor>>;
    await act(async () => {
      putResult = await result.current.upsertAnchor(1, VALID_PAYLOAD);
    });

    expect(putResult).toEqual({ ok: true });

    // Verify the PUT was sent to the correct URL
    const putCall = mockFetch.mock.calls.find(
      ([url, init]: [string, RequestInit]) =>
        (init?.method === "PUT") && String(url).includes(`${BASE}/admin/map-anchors/1`),
    );
    expect(putCall).toBeTruthy();
  });

  it("returns { ok: false, mfaRequired: true } when PUT returns 403 MFA_REQUIRED", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return makeJsonResponse(403, { code: "MFA_REQUIRED" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let putResult!: Awaited<ReturnType<typeof result.current.upsertAnchor>>;
    await act(async () => {
      putResult = await result.current.upsertAnchor(1, VALID_PAYLOAD);
    });

    expect(putResult.ok).toBe(false);
    expect(putResult.mfaRequired).toBe(true);
  });

  it("returns { ok: false } without mfaRequired when PUT returns a 5xx error", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return makeJsonResponse(500, { error: "Internal server error" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let putResult!: Awaited<ReturnType<typeof result.current.upsertAnchor>>;
    await act(async () => {
      putResult = await result.current.upsertAnchor(1, VALID_PAYLOAD);
    });

    expect(putResult.ok).toBe(false);
    // 5xx must NOT be treated as MFA_REQUIRED
    expect(putResult.mfaRequired).toBeFalsy();
  });

  it("returns { ok: false } without mfaRequired when PUT returns 403 WITHOUT MFA_REQUIRED code", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "PUT")
        return makeJsonResponse(403, { code: "FORBIDDEN" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let putResult!: Awaited<ReturnType<typeof result.current.upsertAnchor>>;
    await act(async () => {
      putResult = await result.current.upsertAnchor(1, VALID_PAYLOAD);
    });

    expect(putResult.ok).toBe(false);
    // A 403 with a different code must NOT be treated as MFA_REQUIRED
    expect(putResult.mfaRequired).toBeFalsy();
  });
});

// =============================================================================
// deleteAnchor
// =============================================================================

describe("deleteAnchor — return values", () => {
  it("returns { ok: false, mfaRequired: true } when DELETE returns 403 MFA_REQUIRED", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE")
        return makeJsonResponse(403, { code: "MFA_REQUIRED" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let delResult!: Awaited<ReturnType<typeof result.current.deleteAnchor>>;
    await act(async () => {
      delResult = await result.current.deleteAnchor(1);
    });

    expect(delResult.ok).toBe(false);
    expect(delResult.mfaRequired).toBe(true);
  });

  it("returns { ok: true } when DELETE returns 200", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return makeJsonResponse(200, {});
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let delResult!: Awaited<ReturnType<typeof result.current.deleteAnchor>>;
    await act(async () => {
      delResult = await result.current.deleteAnchor(1);
    });

    expect(delResult).toEqual({ ok: true });
  });

  it("returns { ok: false } without mfaRequired when DELETE returns a 5xx error", async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE")
        return makeJsonResponse(500, { error: "Server error" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    let delResult!: Awaited<ReturnType<typeof result.current.deleteAnchor>>;
    await act(async () => {
      delResult = await result.current.deleteAnchor(1);
    });

    expect(delResult.ok).toBe(false);
    expect(delResult.mfaRequired).toBeFalsy();
  });
});

// =============================================================================
// refetch / GET — MFA_REQUIRED
// =============================================================================

describe("refetch (GET) — MFA_REQUIRED", () => {
  it("sets mfaRequired=true and keeps error=false when GET /admin/map-anchors returns 403 MFA_REQUIRED", async () => {
    mockFetch.mockImplementation(() =>
      makeJsonResponse(403, { code: "MFA_REQUIRED" }),
    );

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    expect(result.current.mfaRequired).toBe(true);
    // MFA is a distinct state — it must not set the generic error flag
    expect(result.current.error).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("sets error=true and keeps mfaRequired=false when GET returns a 5xx error", async () => {
    mockFetch.mockImplementation(() =>
      makeJsonResponse(500, { error: "Internal error" }),
    );

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();

    expect(result.current.error).toBe(true);
    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("clears mfaRequired after a successful refetch", async () => {
    // First fetch: MFA_REQUIRED; second (manual refetch): success
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1)
        return makeJsonResponse(403, { code: "MFA_REQUIRED" });
      return makeJsonResponse(200, { anchors: [] });
    });

    const { result } = renderHook(() => useMapAnchors(ADMIN_TOKEN));
    await flushPromises();
    expect(result.current.mfaRequired).toBe(true);

    // Manual refetch succeeds
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.mfaRequired).toBe(false);
    expect(result.current.error).toBe(false);
  });
});
