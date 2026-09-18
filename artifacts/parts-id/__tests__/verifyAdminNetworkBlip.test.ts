/**
 * @jest-environment node
 *
 * Unit tests for verifyAdminRequest (utils/verifyAdminRequest.ts).
 *
 * These tests lock the behaviour of the periodic admin-status re-check
 * (refreshAdminStatus → verifyAdmin) against two failure modes:
 *
 *   (a) Network error (fetch throws)  — admin state must remain UNCHANGED.
 *       A transient blip or rolling deploy restart should not revoke an
 *       admin's session mid-use.
 *
 *   (b) Non-ok HTTP response          — isAdmin must be set to false and
 *       adminToken cleared.  The server has explicitly rejected the check.
 *
 * The function is also tested for its happy-path and abort-signal contracts
 * so any future refactor cannot accidentally flip the subtle conditions.
 */

import { verifyAdminRequest } from "../utils/verifyAdminRequest";

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
// @ts-ignore — override global fetch in the Node test environment
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:3001/api";
const TOKEN = "test-token-abc123";

function makeAdminResponse(isAdmin: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ isAdmin }),
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "Forbidden" }),
  } as unknown as Response;
}

function makeDeps(overrides: {
  setIsAdmin?: jest.Mock;
  setAdminToken?: jest.Mock;
  signal?: AbortSignal;
} = {}) {
  const setIsAdmin = overrides.setIsAdmin ?? jest.fn();
  const setAdminToken = overrides.setAdminToken ?? jest.fn();
  return {
    deps: {
      apiBase: API_BASE,
      token: TOKEN,
      signal: overrides.signal,
      setIsAdmin,
      setAdminToken,
    },
    setIsAdmin,
    setAdminToken,
  };
}

// ── (a) Network error → admin state unchanged ─────────────────────────────────

describe("verifyAdminRequest — network error (transient blip)", () => {
  it("(a) does NOT call setIsAdmin when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { deps, setIsAdmin, setAdminToken } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setIsAdmin).not.toHaveBeenCalled();
    expect(setAdminToken).not.toHaveBeenCalled();
  });

  it("(a) leaves a pre-existing admin=true state unchanged on connection refused", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Network request failed"));
    const setIsAdmin = jest.fn();
    const setAdminToken = jest.fn();
    const { deps } = makeDeps({ setIsAdmin, setAdminToken });

    await verifyAdminRequest(deps);

    // Both setters must be silent — caller's existing state is preserved.
    expect(setIsAdmin).not.toHaveBeenCalled();
    expect(setAdminToken).not.toHaveBeenCalled();
  });

  it("(a) does not throw when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));
    const { deps } = makeDeps();

    await expect(verifyAdminRequest(deps)).resolves.toBeUndefined();
  });
});

// ── (b) Non-ok HTTP response → isAdmin cleared ───────────────────────────────

describe("verifyAdminRequest — non-ok HTTP response", () => {
  it("(b) sets isAdmin to false on 403", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, setIsAdmin } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setIsAdmin).toHaveBeenCalledWith(false);
  });

  it("(b) clears adminToken on 403", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, setAdminToken } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setAdminToken).toHaveBeenCalledWith(null);
  });

  it("(b) sets isAdmin to false on 401", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    const { deps, setIsAdmin } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setIsAdmin).toHaveBeenCalledWith(false);
  });

  it("(b) leaves admin state unchanged on 500 (transient server error)", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    const { deps, setIsAdmin } = makeDeps();

    await verifyAdminRequest(deps);

    // 5xx responses are non-authoritative transient conditions — the
    // implementation deliberately leaves admin state untouched.
    expect(setIsAdmin).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("verifyAdminRequest — ok response", () => {
  it("sets isAdmin to true and mirrors the token when server returns isAdmin:true", async () => {
    mockFetch.mockResolvedValueOnce(makeAdminResponse(true));
    const { deps, setIsAdmin, setAdminToken } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setIsAdmin).toHaveBeenCalledWith(true);
    expect(setAdminToken).toHaveBeenCalledWith(TOKEN);
  });

  it("sets isAdmin to false and clears the token when server returns isAdmin:false", async () => {
    mockFetch.mockResolvedValueOnce(makeAdminResponse(false));
    const { deps, setIsAdmin, setAdminToken } = makeDeps();

    await verifyAdminRequest(deps);

    expect(setIsAdmin).toHaveBeenCalledWith(false);
    expect(setAdminToken).toHaveBeenCalledWith(null);
  });

  it("sends the bearer token in the Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(makeAdminResponse(true));
    const { deps } = makeDeps();

    await verifyAdminRequest(deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/me");
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });
});

// ── Abort signal ──────────────────────────────────────────────────────────────

describe("verifyAdminRequest — abort signal", () => {
  it("does not update state when signal is aborted before fetch resolves", async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { deps, setIsAdmin, setAdminToken } = makeDeps({ signal: controller.signal });

    await verifyAdminRequest(deps);

    expect(setIsAdmin).not.toHaveBeenCalled();
    expect(setAdminToken).not.toHaveBeenCalled();
  });
});
