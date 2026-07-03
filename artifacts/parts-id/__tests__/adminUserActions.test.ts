/**
 * @jest-environment node
 *
 * Unit tests for fetchAdminUsers and handleUserAction (utils/adminUserActions.ts).
 *
 * Covers:
 *   fetchAdminUsers:
 *   (a) Approve path — GET /admin/users returns a user list; setUsersData is called
 *   (b) Passes the admin token in the Authorization header
 *   (c) API error (non-ok response) — setUsersError is called, setUsersData is not
 *   (d) Network failure (fetch throws) — setUsersError is called
 *   (e) setUsersLoading is true during the request and false after (success and error)
 *
 *   handleUserAction:
 *   (f) Approve path — POST /admin/users/:id/approve is called and fetchUsers is invoked
 *   (g) Ban path    — POST /admin/users/:id/ban    is called and fetchUsers is invoked
 *   (h) Passes the admin token in the Authorization header for action calls
 *   (i) API error — showToast is called with an error message; fetchUsers is NOT called
 *   (j) Network failure — showToast is called; fetchUsers is NOT called
 *   (k) Concurrent guard — returns early without calling fetch when userActionPending is set
 *   (l) setUserActionPending is set to clerkUserId while in flight, then null after
 */

import {
  fetchAdminUsers,
  handleUserAction,
  type FetchAdminUsersDeps,
  type HandleUserActionDeps,
  type UserRow,
} from "../utils/adminUserActions";

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
// @ts-ignore — override global fetch in Node test environment
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = "http://localhost:3001/api";
const ADMIN_TOKEN = "test-admin-token-abc123";

const FIXTURE_USERS: Array<UserRow> = [
  { clerkUserId: "user_a", email: "a@example.com", status: "pending", role: "user", createdAt: "2024-01-01T00:00:00Z" },
  { clerkUserId: "user_b", email: "b@example.com", status: "approved", role: "admin", createdAt: "2024-01-02T00:00:00Z" },
];

function makeOkUsersResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ users: FIXTURE_USERS }),
  } as unknown as Response;
}

function makeOkActionResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ user: FIXTURE_USERS[0] }),
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: "Server error" }),
  } as unknown as Response;
}

function makeFetchUsersDeps(overrides: Partial<FetchAdminUsersDeps> = {}): {
  deps: FetchAdminUsersDeps;
  mocks: {
    setUsersLoading: jest.Mock;
    setUsersError: jest.Mock;
    setUsersData: jest.Mock;
  };
} {
  const mocks = {
    setUsersLoading: jest.fn(),
    setUsersError: jest.fn(),
    setUsersData: jest.fn(),
  };
  return {
    deps: {
      apiBase: API_BASE,
      adminToken: ADMIN_TOKEN,
      ...mocks,
      ...overrides,
    },
    mocks,
  };
}

function makeHandleUserActionDeps(overrides: Partial<HandleUserActionDeps> = {}): {
  deps: HandleUserActionDeps;
  mocks: {
    setUserActionPending: jest.Mock;
    showToast: jest.Mock;
    fetchUsers: jest.Mock;
  };
} {
  const mocks = {
    setUserActionPending: jest.fn(),
    showToast: jest.fn(),
    fetchUsers: jest.fn().mockResolvedValue(undefined),
  };
  return {
    deps: {
      apiBase: API_BASE,
      adminToken: ADMIN_TOKEN,
      userActionPending: null,
      ...mocks,
      ...overrides,
    },
    mocks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchAdminUsers
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchAdminUsers — success path", () => {
  it("(a) calls GET /admin/users and populates setUsersData with the returned list", async () => {
    mockFetch.mockResolvedValueOnce(makeOkUsersResponse());
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersData).toHaveBeenCalledWith(FIXTURE_USERS);
    expect(mocks.setUsersError).toHaveBeenCalledWith(null);
  });

  it("(b) passes the admin token in the Authorization header", async () => {
    mockFetch.mockResolvedValueOnce(makeOkUsersResponse());
    const { deps } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/users");
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it("(e-success) setUsersLoading is true then false on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkUsersResponse());
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersLoading).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setUsersLoading).toHaveBeenNthCalledWith(2, false);
  });
});

describe("fetchAdminUsers — error paths", () => {
  it("(c) non-ok HTTP response calls setUsersError with the status string", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersError).toHaveBeenCalledWith(expect.stringContaining("500"));
    expect(mocks.setUsersData).not.toHaveBeenCalled();
  });

  it("(c) 401 response also calls setUsersError, not setUsersData", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersError).toHaveBeenCalledWith(expect.stringContaining("401"));
    expect(mocks.setUsersData).not.toHaveBeenCalled();
  });

  it("(d) network failure (fetch throws) calls setUsersError with the error message", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersError).toHaveBeenCalledWith("Network timeout");
    expect(mocks.setUsersData).not.toHaveBeenCalled();
  });

  it("(e-error) setUsersLoading is true then false even when the request fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const { deps, mocks } = makeFetchUsersDeps();

    await fetchAdminUsers(deps);

    expect(mocks.setUsersLoading).toHaveBeenNthCalledWith(1, true);
    expect(mocks.setUsersLoading).toHaveBeenNthCalledWith(2, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleUserAction
// ─────────────────────────────────────────────────────────────────────────────

describe("handleUserAction — approve path", () => {
  it("(f) POSTs to /admin/users/:id/approve and then calls fetchUsers on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "approve", deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/users/user_a/approve");
    expect(options?.method).toBe("POST");
    expect(mocks.fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("(h) passes the admin token in the Authorization header for approve", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "approve", deps);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${ADMIN_TOKEN}`);
  });
});

describe("handleUserAction — ban path", () => {
  it("(g) POSTs to /admin/users/:id/ban and then calls fetchUsers on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "ban", deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/users/user_b/ban");
    expect(options?.method).toBe("POST");
    expect(mocks.fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("(h) passes the admin token in the Authorization header for ban", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "ban", deps);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${ADMIN_TOKEN}`);
  });
});

describe("handleUserAction — promote path", () => {
  it("POSTs to /admin/users/:id/promote and then calls fetchUsers on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "promote", deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/users/user_b/promote");
    expect(options?.method).toBe("POST");
    expect(mocks.fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("passes the admin token in the Authorization header for promote", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "promote", deps);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${ADMIN_TOKEN}`);
  });
});

describe("handleUserAction — demote path", () => {
  it("POSTs to /admin/users/:id/demote and then calls fetchUsers on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "demote", deps);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/users/user_b/demote");
    expect(options?.method).toBe("POST");
    expect(mocks.fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("shows a toast and does NOT refresh when demote is rejected (e.g. bootstrap admin)", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400));
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "demote", deps);

    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining("400"),
      "error",
    );
    expect(mocks.fetchUsers).not.toHaveBeenCalled();
  });
});

describe("handleUserAction — error paths", () => {
  it("(i) non-ok HTTP response calls showToast and does NOT call fetchUsers", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "approve", deps);

    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining("500"),
      "error",
    );
    expect(mocks.fetchUsers).not.toHaveBeenCalled();
  });

  it("(j) network failure calls showToast and does NOT call fetchUsers", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "ban", deps);

    expect(mocks.showToast).toHaveBeenCalledWith("Connection refused", "error");
    expect(mocks.fetchUsers).not.toHaveBeenCalled();
  });

  it("(i) ban API error also calls showToast with the status string", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(403));
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_b", "ban", deps);

    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining("403"),
      "error",
    );
    expect(mocks.fetchUsers).not.toHaveBeenCalled();
  });
});

describe("handleUserAction — concurrency and pending state", () => {
  it("(k) returns early without fetching when userActionPending is already set", async () => {
    const { deps, mocks } = makeHandleUserActionDeps({ userActionPending: "user_x" });

    await handleUserAction("user_a", "approve", deps);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.fetchUsers).not.toHaveBeenCalled();
  });

  it("(l) setUserActionPending is set to clerkUserId on start and null on success", async () => {
    mockFetch.mockResolvedValueOnce(makeOkActionResponse());
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "approve", deps);

    expect(mocks.setUserActionPending).toHaveBeenNthCalledWith(1, "user_a");
    expect(mocks.setUserActionPending).toHaveBeenNthCalledWith(2, null);
  });

  it("(l) setUserActionPending is cleared to null even when the request fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("oops"));
    const { deps, mocks } = makeHandleUserActionDeps();

    await handleUserAction("user_a", "ban", deps);

    expect(mocks.setUserActionPending).toHaveBeenNthCalledWith(1, "user_a");
    expect(mocks.setUserActionPending).toHaveBeenNthCalledWith(2, null);
  });
});
