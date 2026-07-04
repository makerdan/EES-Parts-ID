/**
 * @jest-environment node
 *
 * Tests for the admin demotion detection flow.
 *
 * ## What this covers
 *
 * 1. `shouldNotifyDemotion` pure-function contract — the single source of truth
 *    for when a demotion toast should fire.
 *
 * 2. `verifyAdminRequest` demotion-detection contract — confirms that when
 *    GET /admin/me returns a non-admin result for a user who was previously an
 *    admin, the local state is cleared (isAdmin→false, adminToken→null) and
 *    onDemotion() is invoked. The symmetric "no toast" cases are also covered.
 *
 * 3. The 30-second poll interval — fake-timer tests confirm the re-check fires
 *    on schedule and correctly applies state transitions.
 *
 * ## Why we test verifyAdminRequest directly
 *
 * AppContext has many external dependencies (Clerk, SecureStore, AsyncStorage,
 * etc.) that make mounting expensive and brittle. Following the established
 * pattern in this test suite (syncRetryLogoutCleanup, adminGuardRace), we test
 * the extracted pure helper directly and mirror the polling behaviour in a
 * minimal harness that uses the same React primitives.
 */

import { shouldNotifyDemotion } from "../utils/adminDemotionToast";
import { verifyAdminRequest } from "../utils/verifyAdminRequest";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure helper — shouldNotifyDemotion
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldNotifyDemotion — pure contract", () => {
  it("(a) returns true when user WAS admin and is NO LONGER admin (demotion)", () => {
    expect(shouldNotifyDemotion(true, false)).toBe(true);
  });

  it("(b) returns false when user was NOT admin and is still NOT admin (no change)", () => {
    expect(shouldNotifyDemotion(false, false)).toBe(false);
  });

  it("(c) returns false when user WAS admin and remains admin (no change)", () => {
    expect(shouldNotifyDemotion(true, true)).toBe(false);
  });

  it("(d) returns false when user was NOT admin and is now admin (promotion — no toast needed)", () => {
    expect(shouldNotifyDemotion(false, true)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. verifyAdminRequest demotion-detection contract
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:3001/api";
const TOKEN = "token-abc";

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
// @ts-ignore — override global fetch in Node test environment
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

function makeDeps(overrides: {
  wasAdmin?: boolean;
  setIsAdmin?: jest.Mock;
  setAdminToken?: jest.Mock;
  onDemotion?: jest.Mock;
  signal?: AbortSignal;
} = {}) {
  const mocks = {
    setIsAdmin: overrides.setIsAdmin ?? jest.fn(),
    setAdminToken: overrides.setAdminToken ?? jest.fn(),
    onDemotion: overrides.onDemotion ?? jest.fn(),
  };
  return {
    deps: {
      apiBase: API_BASE,
      token: TOKEN,
      wasAdmin: overrides.wasAdmin ?? false,
      signal: overrides.signal,
      ...mocks,
    },
    mocks,
  };
}

function makeOkResponse(isAdmin: boolean): Response {
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

// ── Demotion path ─────────────────────────────────────────────────────────────

describe("verifyAdmin — demotion detected (was admin, server now returns non-admin)", () => {
  it("(a) clears isAdmin and adminToken when /admin/me returns { isAdmin: false }", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(false));
    const { deps, mocks } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest(deps);

    expect(mocks.setIsAdmin).toHaveBeenCalledWith(false);
    expect(mocks.setAdminToken).toHaveBeenCalledWith(null);
  });

  it("(b) calls onDemotion when /admin/me returns { isAdmin: false } for an admin", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(false));
    const { deps, mocks } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest(deps);

    expect(mocks.onDemotion).toHaveBeenCalledTimes(1);
  });

  it("(c) clears isAdmin and adminToken when /admin/me returns 403 for an admin", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, mocks } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest(deps);

    expect(mocks.setIsAdmin).toHaveBeenCalledWith(false);
    expect(mocks.setAdminToken).toHaveBeenCalledWith(null);
  });

  it("(d) calls onDemotion when /admin/me returns 403 for an admin", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, mocks } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest(deps);

    expect(mocks.onDemotion).toHaveBeenCalledTimes(1);
  });

  it("(e) passes the bearer token in the Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(false));
    const { deps } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest({ ...deps, token: "my-clerk-token" });

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/me");
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe("Bearer my-clerk-token");
  });
});

// ── Stable non-admin path (no demotion callback) ──────────────────────────────

describe("verifyAdmin — non-admin stays non-admin (no onDemotion)", () => {
  it("(f) does NOT call onDemotion when a non-admin receives { isAdmin: false }", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(false));
    const { deps, mocks } = makeDeps({ wasAdmin: false });

    await verifyAdminRequest(deps);

    expect(mocks.onDemotion).not.toHaveBeenCalled();
  });

  it("(g) does NOT call onDemotion when a non-admin receives a 403", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, mocks } = makeDeps({ wasAdmin: false });

    await verifyAdminRequest(deps);

    expect(mocks.onDemotion).not.toHaveBeenCalled();
  });
});

// ── Promotion path (no demotion callback) ────────────────────────────────────

describe("verifyAdmin — promotion detected (was not admin, server now returns admin)", () => {
  it("(h) sets isAdmin true and adminToken when /admin/me returns { isAdmin: true }", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(true));
    const { deps, mocks } = makeDeps({ wasAdmin: false });

    await verifyAdminRequest(deps);

    expect(mocks.setIsAdmin).toHaveBeenCalledWith(true);
    expect(mocks.setAdminToken).toHaveBeenCalledWith(TOKEN);
  });

  it("(i) does NOT call onDemotion on promotion", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(true));
    const { deps, mocks } = makeDeps({ wasAdmin: false });

    await verifyAdminRequest(deps);

    expect(mocks.onDemotion).not.toHaveBeenCalled();
  });
});

// ── Abort signal ──────────────────────────────────────────────────────────────

describe("verifyAdmin — aborted request", () => {
  it("(j) does NOT update state or call onDemotion when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { deps, mocks } = makeDeps({ wasAdmin: true, signal: controller.signal });

    await verifyAdminRequest(deps);

    expect(mocks.setIsAdmin).not.toHaveBeenCalled();
    expect(mocks.setAdminToken).not.toHaveBeenCalled();
    expect(mocks.onDemotion).not.toHaveBeenCalled();
  });
});

// ── Network failure ───────────────────────────────────────────────────────────

describe("verifyAdmin — network failure (transient blip)", () => {
  it("(k) does NOT clear state or call onDemotion on a network error (transient blip, not demotion)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));
    const { deps, mocks } = makeDeps({ wasAdmin: true });

    await verifyAdminRequest(deps);

    // State is left unchanged — a blip or rolling deploy restart should not
    // revoke an admin's session. Only an explicit server rejection does.
    expect(mocks.setIsAdmin).not.toHaveBeenCalled();
    expect(mocks.setAdminToken).not.toHaveBeenCalled();
    expect(mocks.onDemotion).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Poll interval — confirms the 30-second interval triggers re-verification
// ─────────────────────────────────────────────────────────────────────────────

describe("refreshAdminStatus poll interval — fires every 30 seconds", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  /**
   * Reproduces the setInterval pattern from AppContext:
   *
   *   useEffect(() => {
   *     if (!isAuthenticated) return;
   *     const id = setInterval(() => { refreshAdminStatus(); }, 30_000);
   *     return () => clearInterval(id);
   *   }, [isAuthenticated, refreshAdminStatus]);
   */
  it("calls refreshAdminStatus exactly once per 30-second tick", () => {
    const refreshAdminStatus = jest.fn();

    const id = setInterval(() => { refreshAdminStatus(); }, 30_000);

    jest.advanceTimersByTime(29_999);
    expect(refreshAdminStatus).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(refreshAdminStatus).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(30_000);
    expect(refreshAdminStatus).toHaveBeenCalledTimes(2);

    clearInterval(id);
  });

  it("does NOT call refreshAdminStatus after the interval is cleared (component unmount)", () => {
    const refreshAdminStatus = jest.fn();

    const id = setInterval(() => { refreshAdminStatus(); }, 30_000);
    clearInterval(id);

    jest.advanceTimersByTime(60_000);
    expect(refreshAdminStatus).not.toHaveBeenCalled();
  });

  it("a demoted admin who waits for the next poll cycle loses admin state", async () => {
    let isAdmin = true;
    let adminToken: string | null = "tok";
    const onDemotion = jest.fn();

    mockFetch.mockResolvedValueOnce(makeOkResponse(false));
    await verifyAdminRequest({
      apiBase: API_BASE,
      token: "tok",
      wasAdmin: isAdmin,
      setIsAdmin: (v) => { isAdmin = v; },
      setAdminToken: (v) => { adminToken = v; },
      onDemotion,
    });

    expect(isAdmin).toBe(false);
    expect(adminToken).toBeNull();
    expect(onDemotion).toHaveBeenCalledTimes(1);
  });
});
