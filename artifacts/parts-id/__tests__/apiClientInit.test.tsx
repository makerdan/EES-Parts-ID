/**
 * Verifies that AppProvider initialises the generated API client's setBaseUrl()
 * with the value exported by API_ORIGIN from utils/apiBase on every mount.
 *
 * Because API_ORIGIN is a module-level constant captured at import time,
 * each scenario uses jest.isolateModules() + jest.doMock() so AppContext is
 * freshly loaded with the correct API_ORIGIN value.  This ensures that a
 * future refactor passing the wrong value to setBaseUrl() would fail here
 * rather than silently misdirecting all generated-client requests.
 *
 * Covered scenarios:
 *  1. Native-dev fallback (no env vars):  API_ORIGIN = "http://localhost:8080"
 *  2. EXPO_PUBLIC_DOMAIN set:             API_ORIGIN = "https://my.repl.co"
 *  3. setBaseUrl is called exactly once per mount
 *  4. Web dev / empty API_ORIGIN (""):    setBaseUrl is NOT called
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── Stable transitive mocks (apply to every isolated registry) ────────────────

jest.mock("expo-secure-store", () => ({
  getItemAsync:  jest.fn(() => Promise.resolve(null)),
  setItemAsync:  jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem:     jest.fn(() => Promise.resolve(null)),
    setItem:     jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("../utils/logoutRegistry", () => {
  const actual = jest.requireActual<typeof import("../utils/logoutRegistry")>("../utils/logoutRegistry");
  return {
    ...actual,
    LogoutRegistry: class {
      register() { return () => {}; }
      fire() {}
    },
  };
});

jest.mock("../utils/sessionStorage", () => ({
  SEARCH_CACHE_KEYS: [],
  SESSION_KEY:       "parts_id_session",
  clearSessionStorage: jest.fn(() => Promise.resolve()),
}));

jest.mock("../utils/storageErrorReporter", () => ({
  reportStorageError:      jest.fn(),
  setStorageErrorHandler:  jest.fn(),
}));

jest.mock("../utils/appAuth", () => ({
  fetchWithAuth:       jest.fn(() => Promise.resolve({ ok: false } as Response)),
  setAppToken:         jest.fn(),
  setAppTokenGetter:   jest.fn(),
  setOnUnauthorized:   jest.fn(),
  notifyTokenAvailable: jest.fn(),
}));

jest.mock("@/constants/colors", () => ({
  __esModule: true,
  default: {
    light: {
      background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
      mutedForeground: "#64748b", destructive: "#ef4444", success: "#22c55e",
      warning: "#f59e0b",
    },
    dark: {
      background: "#000", foreground: "#fff", card: "#111", border: "#333",
      primary: "#3b82f6", primaryForeground: "#fff", muted: "#1e293b",
      mutedForeground: "#94a3b8", destructive: "#ef4444", success: "#22c55e",
      warning: "#f59e0b",
    },
    radius: 8,
  },
}));

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Render AppProvider in an isolated module registry so the AppContext module is
 * freshly required with a controlled API_ORIGIN value (module-level constant
 * captured at import time).  Returns the setBaseUrl spy so the caller can
 * assert on it after the component has mounted and its useEffect has fired.
 */
// Capture outer-registry singletons at module scope (before any isolateModules call).
// Using them outside isolateModules ensures:
//  1. The same React instance is used by both the renderer and AppProvider.
//  2. @testing-library/react-native is NOT re-required inside a running test,
//     which would trigger its top-level beforeAll/afterAll registrations and
//     cause "Hook cannot be defined inside test" errors.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const outerReact = require("react") as typeof import("react");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { render: rtlRender, act: rtlAct } = require("@testing-library/react-native") as typeof import("@testing-library/react-native");

async function renderWithApiOrigin(apiOrigin: string): Promise<jest.Mock> {
  let setBaseUrlSpy!: jest.Mock;
  let capturedAppProvider!: React.ComponentType<{ children?: React.ReactNode }>;

  jest.isolateModules(() => {
    const mockSetBaseUrl = jest.fn();
    setBaseUrlSpy = mockSetBaseUrl;

    // Redirect "react" in the isolated registry to the outer singleton so that
    // hooks inside AppProvider share the same ReactSharedInternals dispatcher
    // as the RTLRN renderer (which also uses the outer React).
    jest.doMock("react", () => outerReact);

    jest.doMock("@workspace/api-client-react", () => ({
      setBaseUrl:          mockSetBaseUrl,
      setAuthTokenGetter:  jest.fn(),
      setUnauthorizedHandler: jest.fn(),
    }));

    jest.doMock("../utils/apiBase", () => ({
      API_ORIGIN: apiOrigin,
      API_BASE:   apiOrigin ? `${apiOrigin}/api` : "",
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppProvider } = require("../contexts/AppContext") as {
      AppProvider: React.ComponentType<{ children?: React.ReactNode }>;
    };
    capturedAppProvider = AppProvider;
    // Do NOT require @testing-library/react-native here — doing so inside
    // isolateModules triggers its top-level hook registrations inside a test.
  });

  // render() OUTSIDE isolateModules: uses the outer RTLRN renderer.
  // outerReact.createElement ensures the element type and hooks all share the
  // same React instance as the renderer.
  await rtlRender(outerReact.createElement(capturedAppProvider, null));
  return setBaseUrlSpy;
}

afterEach(() => {
  jest.resetModules();
});

// ── setAuthTokenGetter helpers ────────────────────────────────────────────────

/**
 * Flush pending microtasks + one macrotask so the async boot effect
 * (Promise.all of SecureStore reads inside AppProvider) and any subsequent
 * React state-update effects settle before we interrogate the getter.
 *
 * @testing-library/react-native is NOT mocked, so the shared `act` works outside
 * of any isolateModules scope.
 */
async function flushAsync(): Promise<void> {
  // First pass: drain Promise.all microtasks so the boot .then() callback runs
  // (appTokenRef.current set directly, setAdminToken/setIsLoading called, etc.)
  await rtlAct(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  // Second pass: flush the React re-render triggered by setAdminToken so the
  // adminTokenRef sync effect fires (adminTokenRef.current = adminToken).
  await rtlAct(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

type TokenHandles = {
  /** The spy passed to setAuthTokenGetter — call [0][0]() to invoke the getter. */
  setAuthTokenGetterSpy: jest.Mock;
  /** Unmount the rendered AppProvider (triggers cleanup effect). */
  unmount: () => Promise<void>;
};

/**
 * Render AppProvider in an isolated module registry with configurable token
 * values, returning the setAuthTokenGetter spy so callers can assert on it
 * after optional async flushing.
 *
 * - adminToken  — stored in SecureStore (parts_id_admin_token); loaded on boot
 * - clerkToken  — returned by the Clerk useAuth().getToken() mock
 * All default to null so tests that don't care about stored tokens start clean.
 */
async function renderWithTokenGetterCapture(opts: {
  sessionToken?: string | null;  // kept for compat; no longer used by AppContext
  adminToken?: string | null;
  clerkToken?: string | null;
  apiOrigin?: string;
} = {}): Promise<TokenHandles> {
  const {
    adminToken = null,
    clerkToken = null,
    apiOrigin = "http://localhost:8080",
  } = opts;

  let setAuthTokenGetterSpy!: jest.Mock;
  let capturedAppProvider!: React.ComponentType<{ children?: React.ReactNode }>;

  jest.isolateModules(() => {
    const mockSetAuthTokenGetter = jest.fn();
    setAuthTokenGetterSpy = mockSetAuthTokenGetter;

    // Override SecureStore so the boot effect reads the desired admin token.
    jest.doMock("expo-secure-store", () => ({
      getItemAsync: jest.fn((key: string) => {
        if (key === "parts_id_admin_token")  return Promise.resolve(adminToken);
        return Promise.resolve(null);
      }),
      setItemAsync:    jest.fn(() => Promise.resolve()),
      deleteItemAsync: jest.fn(() => Promise.resolve()),
    }));

    // Redirect "react" in the isolated registry to the outer singleton so that
    // hooks inside AppProvider share the same ReactSharedInternals dispatcher
    // as the RTLRN renderer (which also uses the outer React).
    jest.doMock("react", () => outerReact);

    // Override @clerk/expo so useAuth().getToken() returns the desired Clerk token.
    jest.doMock("@clerk/expo", () => ({
      useAuth: jest.fn(() => ({
        isSignedIn: clerkToken !== null,
        userId: clerkToken !== null ? "mock-user-id" : null,
        getToken: jest.fn(() => Promise.resolve(clerkToken)),
        isLoaded: true,
      })),
      useClerk: jest.fn(() => ({
        signOut: jest.fn(() => Promise.resolve()),
      })),
      ClerkProvider: ({ children }: { children: React.ReactNode }) =>
        outerReact.createElement(outerReact.Fragment, null, children),
      ClerkLoaded: ({ children }: { children: React.ReactNode }) =>
        outerReact.createElement(outerReact.Fragment, null, children),
    }));

    jest.doMock("@workspace/api-client-react", () => ({
      setBaseUrl:             jest.fn(),
      setAuthTokenGetter:     mockSetAuthTokenGetter,
      setUnauthorizedHandler: jest.fn(),
    }));

    jest.doMock("../utils/apiBase", () => ({
      API_ORIGIN: apiOrigin,
      API_BASE:   apiOrigin ? `${apiOrigin}/api` : "",
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppProvider } = require("../contexts/AppContext") as {
      AppProvider: React.ComponentType<{ children?: React.ReactNode }>;
    };
    capturedAppProvider = AppProvider;
    // Do NOT require @testing-library/react-native here — doing so inside
    // isolateModules triggers its top-level hook registrations inside a test.
  });

  // render() OUTSIDE isolateModules: uses the outer RTLRN renderer.
  // outerReact.createElement ensures the element type and hooks all share the
  // same React instance as the renderer.
  const renderResult = await rtlRender(outerReact.createElement(capturedAppProvider, null));
  const unmountFn = async () => { await renderResult.unmount(); };

  return { setAuthTokenGetterSpy, unmount: unmountFn };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AppProvider — setAuthTokenGetter initialisation", () => {
  // fetchAdminProfile() fires when an admin token is stored; stub fetch so the
  // background call returns a non-OK response (profile=null → no state update)
  // without triggering a real network request in the test environment.
  beforeAll(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false } as Response),
    );
  });
  afterAll(() => {
    // @ts-ignore
    delete global.fetch;
  });

  it("calls setAuthTokenGetter exactly once on mount with a function", async () => {
    const { setAuthTokenGetterSpy } = await renderWithTokenGetterCapture();
    expect(setAuthTokenGetterSpy).toHaveBeenCalledTimes(1);
    expect(typeof setAuthTokenGetterSpy.mock.calls[0][0]).toBe("function");
  });

  it("getter resolves to null when no tokens are stored", async () => {
    const { setAuthTokenGetterSpy } = await renderWithTokenGetterCapture({
      adminToken: null,
      clerkToken: null,
    });
    const getter = setAuthTokenGetterSpy.mock.calls[0][0] as () => Promise<string | null>;
    expect(await getter()).toBeNull();
  });

  it("getter resolves to Clerk token when only a Clerk token is available", async () => {
    const { setAuthTokenGetterSpy } = await renderWithTokenGetterCapture({
      adminToken: null,
      clerkToken: "app-tok-abc123",
    });
    // Flush async work so the boot effect and Clerk hook settle.
    await flushAsync();
    const getter = setAuthTokenGetterSpy.mock.calls[0][0] as () => Promise<string | null>;
    expect(await getter()).toBe("app-tok-abc123");
  });

  it("getter always resolves to the Clerk token — there is no separate admin token", async () => {
    // Admin authority is role-based now; the auth getter has a single source
    // (the Clerk session token). Even a legacy admin token lingering in
    // SecureStore must be ignored by the getter.
    const { setAuthTokenGetterSpy } = await renderWithTokenGetterCapture({
      clerkToken: "app-tok-xyz",
      adminToken: "legacy-admin-tok-xyz",
    });
    await flushAsync();
    const getter = setAuthTokenGetterSpy.mock.calls[0][0] as () => Promise<string | null>;
    expect(await getter()).toBe("app-tok-xyz");
  });

  it("calls setAuthTokenGetter(null) on unmount (cleanup path)", async () => {
    const { setAuthTokenGetterSpy, unmount } = await renderWithTokenGetterCapture();
    await unmount();
    // The last call must be the cleanup null — not a re-registration.
    const calls = setAuthTokenGetterSpy.mock.calls;
    expect(calls[calls.length - 1][0]).toBeNull();
  });
});

describe("AppProvider — setBaseUrl initialisation", () => {
  it("calls setBaseUrl with http://localhost:8080 on native-dev (no env vars set)", async () => {
    const setBaseUrl = await renderWithApiOrigin("http://localhost:8080");
    expect(setBaseUrl).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("calls setBaseUrl with https://<domain> when EXPO_PUBLIC_DOMAIN is set", async () => {
    const setBaseUrl = await renderWithApiOrigin("https://my.repl.co");
    expect(setBaseUrl).toHaveBeenCalledWith("https://my.repl.co");
  });

  it("calls setBaseUrl exactly once on mount (not on every render)", async () => {
    const setBaseUrl = await renderWithApiOrigin("http://localhost:8080");
    expect(setBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("does NOT call setBaseUrl when API_ORIGIN is empty (web dev / relative-URL mode)", async () => {
    const setBaseUrl = await renderWithApiOrigin("");
    expect(setBaseUrl).not.toHaveBeenCalled();
  });
});
