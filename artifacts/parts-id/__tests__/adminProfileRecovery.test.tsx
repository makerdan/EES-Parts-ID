/**
 * Covers retry and auth-epoch guards for the admin profile hydration request.
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

type MockAuthState = {
  isSignedIn: boolean;
  userId: string | null;
  getToken: () => Promise<string | null>;
  isLoaded: boolean;
};

const mockFetchWithAuth = jest.fn();
const mockAppStateListeners: Array<(state: string) => void> = [];
let mockAuthState: MockAuthState = {
  isSignedIn: true,
  userId: "admin-user-1",
  getToken: async () => "admin-token-1",
  isLoaded: true,
};

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    multiRemove: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuthState,
  useClerk: () => ({ signOut: jest.fn(() => Promise.resolve()) }),
}));

jest.mock("@workspace/api-client-react", () => ({
  setBaseUrl: jest.fn(),
  setAuthTokenGetter: jest.fn(),
  setUnauthorizedHandler: jest.fn(),
}));

jest.mock("../utils/appAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  setAppTokenGetter: jest.fn(),
  setOnUnauthorized: jest.fn(),
  notifyTokenAvailable: jest.fn(),
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
  clearSessionStorage: jest.fn(() => Promise.resolve()),
}));

jest.mock("../utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
  setStorageErrorHandler: jest.fn(),
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

jest.mock("react-native", () => {
  const native = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    ...native,
    AppState: {
      ...native.AppState,
      addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
        mockAppStateListeners.push(listener);
        return { remove: jest.fn() };
      }),
    },
  };
});

import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

import { AppProvider, useApp } from "../contexts/AppContext";

function SettingsProbe() {
  const { settings, isAdmin } = useApp();
  return <Text testID="admin-settings">{`${settings.dimensionUnit}:${isAdmin}`}</Text>;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn(() => Promise.resolve(body)),
  } as unknown as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockAppStateListeners.length = 0;
  mockAuthState = {
    isSignedIn: true,
    userId: "admin-user-1",
    getToken: async () => "admin-token-1",
    isLoaded: true,
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/status")) return jsonResponse({ status: "approved" });
    if (url.endsWith("/admin/me")) return jsonResponse({ isAdmin: true });
    return { ok: false, status: 404 } as Response;
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

async function emitForeground() {
  await act(async () => {
    for (const listener of [...mockAppStateListeners]) listener("active");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("AppProvider admin profile recovery", () => {
  it("retries a failed first profile read on foreground and applies the recovered profile", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dimensionUnit: "in" }),
      });

    const view = await render(
      <AppProvider><SettingsProbe /></AppProvider>,
    );

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("admin-settings").props.children).toBe("mm:true");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    await emitForeground();

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
      expect(view.getByTestId("admin-settings").props.children).toBe("in:true");
    });
  });

  it("ignores a profile response from the prior auth epoch", async () => {
    let resolveFirstProfile!: (response: Response) => void;
    const firstProfileRequest = new Promise<Response>((resolve) => {
      resolveFirstProfile = resolve;
    });
    mockFetchWithAuth
      .mockImplementationOnce(() => firstProfileRequest)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dimensionUnit: "cm" }),
      });

    const view = await render(
      <AppProvider><SettingsProbe /></AppProvider>,
    );
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));
    const firstSignal = mockFetchWithAuth.mock.calls[0][1].signal as AbortSignal;

    mockAuthState = {
      isSignedIn: true,
      userId: "admin-user-2",
      getToken: async () => "admin-token-2",
      isLoaded: true,
    };
    await act(async () => {
      await view.rerender(<AppProvider><SettingsProbe /></AppProvider>);
    });

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(view.getByTestId("admin-settings").props.children).toBe("cm:true");
    });
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      resolveFirstProfile(jsonResponse({ dimensionUnit: "in" }));
      await firstProfileRequest;
    });

    expect(view.getByTestId("admin-settings").props.children).toBe("cm:true");
  });
});