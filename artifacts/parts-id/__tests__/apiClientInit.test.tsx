/**
 * @jest-environment node
 *
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

jest.mock("../utils/logoutRegistry", () => ({
  LogoutRegistry: class {
    register() { return () => {}; }
    fire() {}
  },
}));

jest.mock("../utils/sessionStorage", () => ({
  SEARCH_CACHE_KEYS: [],
  SESSION_KEY:       "parts_id_session",
  ADMIN_TOKEN_KEY:   "parts_id_admin_token",
  clearSessionStorage: jest.fn(() => Promise.resolve()),
}));

jest.mock("../utils/storageErrorReporter", () => ({
  reportStorageError:      jest.fn(),
  setStorageErrorHandler:  jest.fn(),
}));

jest.mock("../utils/appAuth", () => ({
  setAdminToken:    jest.fn(),
  setAppToken:      jest.fn(),
  setOnUnauthorized: jest.fn(),
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
function renderWithApiOrigin(apiOrigin: string): jest.Mock {
  let setBaseUrlSpy!: jest.Mock;

  jest.isolateModules(() => {
    const mockSetBaseUrl = jest.fn();
    setBaseUrlSpy = mockSetBaseUrl;

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
    const React = require("react") as typeof import("react");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppProvider } = require("../contexts/AppContext") as {
      AppProvider: React.ComponentType<{ children?: React.ReactNode }>;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { act, create } = require("react-test-renderer") as typeof import("react-test-renderer");

    act(() => {
      create(React.createElement(AppProvider, null));
    });
  });

  return setBaseUrlSpy;
}

afterEach(() => {
  jest.resetModules();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AppProvider — setBaseUrl initialisation", () => {
  it("calls setBaseUrl with http://localhost:8080 on native-dev (no env vars set)", () => {
    const setBaseUrl = renderWithApiOrigin("http://localhost:8080");
    expect(setBaseUrl).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("calls setBaseUrl with https://<domain> when EXPO_PUBLIC_DOMAIN is set", () => {
    const setBaseUrl = renderWithApiOrigin("https://my.repl.co");
    expect(setBaseUrl).toHaveBeenCalledWith("https://my.repl.co");
  });

  it("calls setBaseUrl exactly once on mount (not on every render)", () => {
    const setBaseUrl = renderWithApiOrigin("http://localhost:8080");
    expect(setBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("does NOT call setBaseUrl when API_ORIGIN is empty (web dev / relative-URL mode)", () => {
    const setBaseUrl = renderWithApiOrigin("");
    expect(setBaseUrl).not.toHaveBeenCalled();
  });
});
