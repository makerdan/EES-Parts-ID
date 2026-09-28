/**
 * @jest-environment node
 *
 * Account-bound history state must never publish a previous Clerk session's
 * results after an account switch or logout.
 */
// @ts-ignore — global augmentation for the React test environment.
global.IS_REACT_ACT_ENVIRONMENT = true;

const mockAuth = {
  isLoaded: true,
  isSignedIn: true as boolean,
  userId: "user-a" as string | null,
  getToken: jest.fn(async (): Promise<string | null> => "session-token"),
};
let mockIsAuthenticated = true;
let mockLogoutHandler: (() => void) | null = null;
const mockMultiRemove = jest.fn<Promise<void>, [Array<string>]>();
const mockFetchWithAuth = jest.fn();

jest.mock("@clerk/expo", () => ({
  useAuth: () => mockAuth,
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    multiRemove: (...args: [Array<string>]) => mockMultiRemove(...args),
  },
}));

jest.mock("@/utils/appAuth", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

jest.mock("@/utils/apiBase", () => ({ API_BASE: "/api" }));

jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
}));

jest.mock("@/utils/logoutRegistry", () => ({}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    isAuthenticated: mockIsAuthenticated,
    registerLogoutHandler: (handler: () => void) => {
      mockLogoutHandler = handler;
      return () => {
        if (mockLogoutHandler === handler) mockLogoutHandler = null;
      };
    },
  }),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { UserHistoryProvider, useUserHistory } from "@/contexts/UserHistoryContext";
import { LEGACY_USER_HISTORY_KEYS, SEARCH_CACHE_KEYS } from "@/utils/sessionStorage";
import type { UserHistorySnapshot } from "@/utils/userHistoryApi";

function response(history: UserHistorySnapshot) {
  return {
    ok: true,
    status: 200,
    json: async () => history,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function HistoryProbe() {
  const { history, status, recordQuery } = useUserHistory();
  return (
    <>
      <Text testID="history-state">{JSON.stringify({ history, status })}</Text>
      <Pressable
        testID="record-query"
        onPress={() => {
          recordQuery("late account A write").catch(() => {});
        }}
      >
        <Text>Record query</Text>
      </Pressable>
    </>
  );
}

function Wrapper() {
  return (
    <UserHistoryProvider
      isAuthenticated={mockIsAuthenticated}
      registerLogoutHandler={(handler) => {
        mockLogoutHandler = handler;
        return () => {
          if (mockLogoutHandler === handler) mockLogoutHandler = null;
        };
      }}
    >
      <HistoryProbe />
    </UserHistoryProvider>
  );
}

function historyFor(query: string): UserHistorySnapshot {
  return {
    queryHistory: [query],
    viewedHistory: [{
      id: query.length,
      catalog: query,
      name: `${query} viewed`,
      vendor: "Example",
      timestamp: "2026-09-25T12:00:00.000Z",
    }],
    scanHistory: [{
      barcode: query,
      found: true,
      timestamp: "2026-09-25T12:00:00.000Z",
    }],
  };
}

function visibleHistory(): UserHistorySnapshot {
  const node = screen.getByTestId("history-state");
  const parsed = JSON.parse(node.props.children) as { history: UserHistorySnapshot };
  return parsed.history;
}

beforeEach(() => {
  mockAuth.isLoaded = true;
  mockAuth.isSignedIn = true;
  mockAuth.userId = "user-a";
  mockIsAuthenticated = true;
  mockLogoutHandler = null;
  mockMultiRemove.mockReset().mockResolvedValue(undefined);
  mockFetchWithAuth.mockReset().mockResolvedValue(response(historyFor("account-a-query")));
});

describe("UserHistoryProvider account isolation", () => {
  it("clears account A's visible history as soon as identity changes to B", async () => {
    const result = await render(<Wrapper />);
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-a-query"));
    });

    const delayedB = deferred<ReturnType<typeof response>>();
    mockAuth.userId = "user-b";
    mockFetchWithAuth.mockImplementationOnce(() => delayedB.promise);
    await result.rerender(<Wrapper />);
    expect(visibleHistory()).toEqual({
      queryHistory: [],
      viewedHistory: [],
      scanHistory: [],
    });

    delayedB.resolve(response(historyFor("account-b-query")));
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-b-query"));
    });
    expect(visibleHistory()).not.toEqual(expect.objectContaining({
      queryHistory: ["account-a-query"],
    }));
  });

  it("ignores account A's delayed response after B becomes the active account", async () => {
    const delayedA = deferred<ReturnType<typeof response>>();
    mockFetchWithAuth
      .mockImplementationOnce(() => delayedA.promise)
      .mockResolvedValueOnce(response(historyFor("account-b-query")));

    const result = await render(<Wrapper />);
    mockAuth.userId = "user-b";
    await result.rerender(<Wrapper />);
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-b-query"));
    });

    await act(async () => {
      delayedA.resolve(response(historyFor("late-account-a-query")));
      await delayedA.promise;
    });
    expect(visibleHistory()).toEqual(historyFor("account-b-query"));
  });

  it("ignores an account A save response that finishes after switching to B", async () => {
    const result = await render(<Wrapper />);
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-a-query"));
    });

    const delayedSave = deferred<ReturnType<typeof response>>();
    mockFetchWithAuth.mockImplementationOnce(() => delayedSave.promise);
    await act(async () => {
      fireEvent.press(screen.getByTestId("record-query"));
    });
    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/user/history",
        expect.objectContaining({ method: "PATCH" }),
        15_000,
      );
    });

    mockAuth.userId = "user-b";
    mockFetchWithAuth.mockResolvedValueOnce(response(historyFor("account-b-query")));
    await result.rerender(<Wrapper />);
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-b-query"));
    });

    await act(async () => {
      delayedSave.resolve(response(historyFor("late-account-a-save")));
      await delayedSave.promise;
    });
    expect(visibleHistory()).toEqual(historyFor("account-b-query"));
  });

  it("clears history in memory on logout and removes only the three legacy history keys", async () => {
    const result = await render(<Wrapper />);
    await waitFor(() => {
      expect(visibleHistory()).toEqual(historyFor("account-a-query"));
    });
    expect(mockMultiRemove).toHaveBeenCalledWith(LEGACY_USER_HISTORY_KEYS);
    expect(LEGACY_USER_HISTORY_KEYS).toHaveLength(3);
    expect(LEGACY_USER_HISTORY_KEYS).not.toEqual(
      expect.arrayContaining(SEARCH_CACHE_KEYS),
    );

    await act(async () => {
      mockIsAuthenticated = false;
      mockLogoutHandler?.();
      await result.rerender(<Wrapper />);
    });
    expect(visibleHistory()).toEqual({
      queryHistory: [],
      viewedHistory: [],
      scanHistory: [],
    });
  });
});