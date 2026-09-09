/**
 * Rendered-screen regression coverage for the protected admin audit log.
 *
 * The real screen is mounted with an authenticated admin context. The test
 * resolves deterministic paginated responses through the screen so it can
 * verify the cursor, auth header, rendered ordering, and recoverable error
 * state at the UI boundary.
 */

// Required for act() to work in the node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

// ── expo-router ─────────────────────────────────────────────────────────────

const mockRouter = {
  back: jest.fn(),
  replace: jest.fn(),
};

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
}));

// ── Native/UI dependencies ──────────────────────────────────────────────────

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());
jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://localhost:3001/api" }));
jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

// ── Contexts ─────────────────────────────────────────────────────────────────

// These modules resolve to the shared Jest mocks via jest.config.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApiHealth } = require("@/contexts/ApiHealthContext") as { useApiHealth: jest.Mock };

// ── Network fixture ─────────────────────────────────────────────────────────

type AuditRow = {
  id: number;
  adminClerkUserId: string;
  targetClerkUserId: string;
  action: "approve" | "ban" | "promote" | "demote";
  createdAt: string;
};

type AuditPage = {
  rows: AuditRow[];
  nextCursor: number | null;
};

const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
// @ts-ignore — override global fetch in the node test environment
global.fetch = mockFetch;

function jsonResponse(body: AuditPage, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function auditRow(
  id: number,
  targetClerkUserId: string,
  action: AuditRow["action"] = "approve",
): AuditRow {
  return {
    id,
    adminClerkUserId: "admin-clerk-user",
    targetClerkUserId,
    action,
    createdAt: "2026-09-02T12:00:00.000Z",
  };
}

const firstPage: AuditPage = {
  rows: [
    auditRow(101, "target-newest"),
    auditRow(100, "target-next", "promote"),
  ],
  nextCursor: 100,
};

const secondPage: AuditPage = {
  rows: [
    auditRow(99, "target-older", "ban"),
    auditRow(98, "target-oldest", "demote"),
  ],
  nextCursor: null,
};

// ── Render/instance helpers ─────────────────────────────────────────────────

type Inst = TestInstance;

function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instText(child as Inst | string))
    .join("");
}

function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll(
        (node: TestInstance) => (node.type as string) === "rn-pressable",
        { includeSelf: true },
      )
      .find((node) => instText(node).includes(label)) ?? null
  );
}

function findPressableByAccessibilityLabel(root: Inst, label: string): Inst | null {
  return (
    root
      .queryAll(
        (node: TestInstance) =>
          (node.type as string) === "rn-pressable" &&
          node.props.accessibilityLabel === label,
        { includeSelf: true },
      )
      .at(0) ?? null
  );
}

function renderedTargets(root: Inst): string[] {
  const actionLabels = new Set(["Approved", "Banned", "Promoted", "Demoted"]);
  return root
    .queryAll(
      (node: TestInstance) =>
        (node.type as string) === "rn-view" &&
        node.children.some(
          (child) => {
            if (typeof child === "string" || (child as TestInstance).type !== "rn-view") {
              return false;
            }
            return (child as TestInstance).children.some(
              (badgeChild) =>
                typeof badgeChild !== "string" &&
                (badgeChild as TestInstance).type === "Text" &&
                actionLabels.has(instText(badgeChild as TestInstance)),
            );
          },
        ),
      { includeSelf: true },
    )
    .flatMap((node) => {
      const texts = node
        .queryAll(
          (child: TestInstance) => (child.type as string) === "Text",
          { includeSelf: true },
        )
        .map((child) => instText(child));
      const targetIndex = texts.indexOf("Target");
      return targetIndex >= 0 ? [texts[targetIndex + 1] ?? ""] : [];
    });
}

function accessibilityLabels(root: Inst): string[] {
  return root
    .queryAll(
      (node: TestInstance) =>
        (node.type as string) === "Text" && typeof node.props.accessibilityLabel === "string",
      { includeSelf: true },
    )
    .map((node) => node.props.accessibilityLabel as string);
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderScreen(adminToken = "admin-token-abc") {
  useApp.mockReturnValue({
    isAdmin: true,
    adminToken,
    isLoading: false,
  });
  useApiHealth.mockReturnValue({
    reportNetworkFailure: jest.fn(),
  });

  const result = await render(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    React.createElement(require("../app/admin-audit-log").default),
  );
  await flushPromises();
  return result;
}

afterEach(async () => {
  mockFetch.mockReset();
  useApp.mockReset();
  useApiHealth.mockReset();
  mockRouter.back.mockClear();
  mockRouter.replace.mockClear();
});


describe("AdminAuditLogScreen — authenticated pagination workflow", () => {
  it("loads the first page, sends the cursor, and appends the next page once", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    const screen = await renderScreen();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3001/api/admin/audit-log?limit=50",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token-abc" } }),
    );
    expect(instText(screen.root!)).toContain("2 events+");
    expect(accessibilityLabels(screen.root!)).toEqual(
      expect.arrayContaining([
        "Admin ID: admin-clerk-user",
        "Target ID: target-newest",
        "Target ID: target-next",
      ]),
    );

    const loadMore = findPressableByAccessibilityLabel(
      screen.root!,
      "Load more audit log entries",
    );
    expect(loadMore).not.toBeNull();

    await act(async () => {
      fireEvent.press(loadMore!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/admin/audit-log?limit=50&before_id=100",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token-abc" } }),
    );
    expect(instText(screen.root!)).toContain("4 events");
    expect(instText(screen.root!)).not.toContain("4 events+");

    const targets = renderedTargets(screen.root!);
    expect(targets).toEqual([
      "target-newest",
      "target-next",
      "target-older",
      "target-oldest",
    ]);
    expect(new Set(targets).size).toBe(targets.length);
    expect(
      findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries"),
    ).toBeNull();

    await act(async () => {
      screen.unmount();
    });
  });

  it("renders overlapping pages once while preserving the next-page cursor", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(
        jsonResponse({
          rows: [
            auditRow(100, "target-next", "promote"),
            auditRow(99, "target-older", "ban"),
            auditRow(98, "target-oldest", "demote"),
          ],
          nextCursor: null,
        }),
      );

    const screen = await renderScreen();
    const loadMore = findPressableByAccessibilityLabel(
      screen.root!,
      "Load more audit log entries",
    );
    expect(loadMore).not.toBeNull();

    await act(async () => {
      fireEvent.press(loadMore!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3001/api/admin/audit-log?limit=50&before_id=100",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token-abc" } }),
    );
    expect(instText(screen.root!)).toContain("4 events");
    expect(instText(screen.root!)).not.toContain("5 events");
    expect(instText(screen.root!)).not.toContain("4 events+");

    const targets = renderedTargets(screen.root!);
    expect(targets).toEqual([
      "target-newest",
      "target-next",
      "target-older",
      "target-oldest",
    ]);
    expect(new Set(targets).size).toBe(targets.length);
    expect(
      findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries"),
    ).toBeNull();

    await act(async () => {
      screen.unmount();
    });
  });

  it("shows the load-more error and retries without duplicating the first page", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(firstPage, false, 503))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    const screen = await renderScreen();
    const loadMore = findPressableByAccessibilityLabel(
      screen.root!,
      "Load more audit log entries",
    );
    expect(loadMore).not.toBeNull();

    await act(async () => {
      fireEvent.press(loadMore!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(instText(screen.root!)).toContain("Server error 503");
    expect(findPressable(screen.root!, "Retry")).not.toBeNull();
    expect(instText(screen.root!)).toContain("2 events+");
    expect(renderedTargets(screen.root!)).toEqual(["target-newest", "target-next"]);
    expect(
      screen.root!.queryAll(
        (node: TestInstance) =>
          (node.type as string) === "rn-view" &&
          node.props.accessibilityRole === "alert" &&
          node.props.accessibilityLiveRegion === "polite",
        { includeSelf: true },
      ),
    ).not.toHaveLength(0);
    expect(
      findPressableByAccessibilityLabel(screen.root!, "Retry loading more audit log entries"),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.press(findPressable(screen.root!, "Retry")!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3001/api/admin/audit-log?limit=50&before_id=100",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token-abc" } }),
    );
    expect(instText(screen.root!)).toContain("4 events");
    expect(instText(screen.root!)).not.toContain("Server error 503");

    const targets = renderedTargets(screen.root!);
    expect(targets).toEqual([
      "target-newest",
      "target-next",
      "target-older",
      "target-oldest",
    ]);
    expect(new Set(targets).size).toBe(targets.length);

    await act(async () => {
      screen.unmount();
    });
  });

  it("keeps the refresh result and cursor when refresh finishes before stale load-more", async () => {
    const staleLoadMore = deferred<Response>();
    const refresh = deferred<Response>();
    let staleLoadMoreSignal: AbortSignal | undefined;
    const refreshedPage: AuditPage = {
      rows: [
        auditRow(201, "refresh-newest", "promote"),
        auditRow(200, "refresh-next"),
      ],
      nextCursor: 200,
    };

    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce((_url, init) => {
        staleLoadMoreSignal = (init as RequestInit).signal ?? undefined;
        return staleLoadMore.promise;
      })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce(jsonResponse(secondPage));

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });
    expect(staleLoadMoreSignal?.aborted).toBe(true);

    await act(async () => {
      refresh.resolve(jsonResponse(refreshedPage));
      await refresh.promise;
    });
    expect(renderedTargets(screen.root!)).toEqual([
      "refresh-newest",
      "refresh-next",
    ]);
    expect(instText(screen.root!)).toContain("2 events+");

    await act(async () => {
      staleLoadMore.resolve(jsonResponse(secondPage));
      await staleLoadMore.promise;
    });
    expect(renderedTargets(screen.root!)).toEqual([
      "refresh-newest",
      "refresh-next",
    ]);
    expect(instText(screen.root!)).toContain("2 events+");

    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });
    await flushPromises();
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      "http://localhost:3001/api/admin/audit-log?limit=50&before_id=200",
      expect.objectContaining({ headers: { Authorization: "Bearer admin-token-abc" } }),
    );
    expect(renderedTargets(screen.root!)).toEqual([
      "refresh-newest",
      "refresh-next",
      "target-older",
      "target-oldest",
    ]);

    await act(async () => {
      screen.unmount();
    });
  });

  it("announces active loading and refresh states to screen readers", async () => {
    const loadMore = deferred<Response>();
    const refresh = deferred<Response>();
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce(() => loadMore.promise)
      .mockImplementationOnce(() => refresh.promise);

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });

    expect(
      screen.root!.queryAll(
        (node: TestInstance) =>
          node.props.accessibilityLabel === "Loading more audit log entries" &&
          node.props.accessibilityLiveRegion === "polite",
        { includeSelf: true },
      ),
    ).not.toHaveLength(0);

    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });
    const refreshButton = findPressableByAccessibilityLabel(
      screen.root!,
      "Refreshing audit log",
    );
    expect(refreshButton).not.toBeNull();
    expect(refreshButton!.props.accessibilityState).toEqual({ busy: true });
    expect(
      screen.root!.queryAll(
        (node: TestInstance) =>
          node.props.accessibilityLabel === "Refreshing audit log" &&
          node.props.accessibilityLiveRegion === "polite",
        { includeSelf: true },
      ),
    ).not.toHaveLength(0);

    await act(async () => {
      refresh.resolve(jsonResponse(firstPage));
      await refresh.promise;
      loadMore.resolve(jsonResponse(secondPage));
      await loadMore.promise;
    });
    await flushPromises();
    await act(async () => {
      screen.unmount();
    });
  });

  it("keeps the newest refresh result when load-more finishes before refresh", async () => {
    const refresh = deferred<Response>();
    const refreshedPage: AuditPage = {
      rows: [
        auditRow(301, "latest-newest", "promote"),
        auditRow(300, "latest-next"),
      ],
      nextCursor: 300,
    };

    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage))
      .mockImplementationOnce(() => refresh.promise);

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });
    await flushPromises();
    expect(renderedTargets(screen.root!)).toEqual([
      "target-newest",
      "target-next",
      "target-older",
      "target-oldest",
    ]);

    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });
    await act(async () => {
      refresh.resolve(jsonResponse(refreshedPage));
      await refresh.promise;
    });

    expect(renderedTargets(screen.root!)).toEqual([
      "latest-newest",
      "latest-next",
    ]);
    expect(instText(screen.root!)).toContain("2 events+");
    expect(instText(screen.root!)).not.toContain("4 events");

    await act(async () => {
      screen.unmount();
    });
  });

  it("aborts an in-flight refresh when the screen unmounts", async () => {
    const refresh = deferred<Response>();
    let refreshSignal: AbortSignal | undefined;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce((_url, init) => {
        refreshSignal = (init as RequestInit).signal ?? undefined;
        return refresh.promise;
      });

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });
    expect(refreshSignal?.aborted).toBe(false);

    await act(async () => {
      screen.unmount();
    });
    expect(refreshSignal?.aborted).toBe(true);

    await act(async () => {
      refresh.resolve(jsonResponse({
        rows: [auditRow(201, "should-not-render")],
        nextCursor: null,
      }));
      await refresh.promise;
    });
  });

  it("aborts an in-flight load-more request when the screen unmounts", async () => {
    const loadMore = deferred<Response>();
    let loadMoreSignal: AbortSignal | undefined;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce((_url, init) => {
        loadMoreSignal = (init as RequestInit).signal ?? undefined;
        return loadMore.promise;
      });

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });
    expect(loadMoreSignal?.aborted).toBe(false);

    await act(async () => {
      screen.unmount();
    });
    expect(loadMoreSignal?.aborted).toBe(true);

    await act(async () => {
      loadMore.resolve(jsonResponse(secondPage));
      await loadMore.promise;
    });
  });

  it("aborts an in-flight refresh when admin access ends", async () => {
    const refresh = deferred<Response>();
    let refreshSignal: AbortSignal | undefined;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce((_url, init) => {
        refreshSignal = (init as RequestInit).signal ?? undefined;
        return refresh.promise;
      });

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });

    useApp.mockReturnValue({
      isAdmin: false,
      adminToken: null,
      isLoading: false,
    });
    await act(async () => {
      await screen.rerender(
        React.createElement(require("../app/admin-audit-log").default),
      );
      await Promise.resolve();
    });

    expect(refreshSignal?.aborted).toBe(true);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)");

    await act(async () => {
      refresh.resolve(jsonResponse({
        rows: [auditRow(301, "should-not-render")],
        nextCursor: null,
      }));
      await refresh.promise;
    });
    expect(instText(screen.root!)).not.toContain("should-not-render");

    await act(async () => {
      screen.unmount();
    });
  });

  it("aborts an in-flight load-more request when admin access ends", async () => {
    const loadMore = deferred<Response>();
    let loadMoreSignal: AbortSignal | undefined;
    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce((_url, init) => {
        loadMoreSignal = (init as RequestInit).signal ?? undefined;
        return loadMore.promise;
      });

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });

    useApp.mockReturnValue({
      isAdmin: false,
      adminToken: null,
      isLoading: false,
    });
    await act(async () => {
      await screen.rerender(
        React.createElement(require("../app/admin-audit-log").default),
      );
      await Promise.resolve();
    });

    expect(loadMoreSignal?.aborted).toBe(true);
    expect(mockRouter.replace).toHaveBeenCalledWith("/(tabs)");

    await act(async () => {
      loadMore.resolve(jsonResponse({
        rows: [auditRow(302, "should-not-render")],
        nextCursor: null,
      }));
      await loadMore.promise;
    });
    expect(instText(screen.root!)).not.toContain("should-not-render");

    await act(async () => {
      screen.unmount();
    });
  });

  it("recovers from a failed refresh without allowing stale load-more success to replace it", async () => {
    const staleLoadMore = deferred<Response>();
    const refresh = deferred<Response>();
    const retryPage: AuditPage = {
      rows: [
        auditRow(401, "retry-newest", "promote"),
        auditRow(400, "retry-next"),
      ],
      nextCursor: 400,
    };

    mockFetch
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockImplementationOnce(() => staleLoadMore.promise)
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce(jsonResponse(retryPage));

    const screen = await renderScreen();
    await act(async () => {
      fireEvent.press(
        findPressableByAccessibilityLabel(screen.root!, "Load more audit log entries")!,
      );
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.press(findPressableByAccessibilityLabel(screen.root!, "Refresh")!);
      await Promise.resolve();
    });

    await act(async () => {
      refresh.reject(new Error("Refresh failed"));
      await expect(refresh.promise).rejects.toThrow("Refresh failed");
    });
    await act(async () => {
      staleLoadMore.resolve(jsonResponse(secondPage));
      await staleLoadMore.promise;
    });

    expect(instText(screen.root!)).toContain("Refresh failed");
    expect(renderedTargets(screen.root!)).toEqual(["target-newest", "target-next"]);
    expect(instText(screen.root!)).toContain("2 events+");
    expect(
      screen.root!.queryAll(
        (node: TestInstance) =>
          (node.type as string) === "rn-view" &&
          node.props.accessibilityRole === "alert",
        { includeSelf: true },
      ),
    ).not.toHaveLength(0);
    expect(
      findPressableByAccessibilityLabel(screen.root!, "Retry refreshing audit log"),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.press(findPressable(screen.root!, "Retry")!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(renderedTargets(screen.root!)).toEqual([
      "retry-newest",
      "retry-next",
    ]);
    expect(instText(screen.root!)).toContain("2 events+");
    expect(instText(screen.root!)).not.toContain("Refresh failed");

    await act(async () => {
      screen.unmount();
    });
  });

  it("keeps two admin sessions on their snapshots until the second session refreshes", async () => {
    const sharedAuditRows = [
      auditRow(101, "target-newest"),
      auditRow(100, "target-next", "promote"),
    ];
    const requestTokens: string[] = [];
    mockFetch.mockImplementation(async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      requestTokens.push(headers?.Authorization ?? "");
      return jsonResponse({ rows: [...sharedAuditRows], nextCursor: null });
    });

    const sessionA = await renderScreen("admin-session-a");
    const sessionB = await renderScreen("admin-session-b");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(requestTokens).toEqual([
      "Bearer admin-session-a",
      "Bearer admin-session-b",
    ]);
    expect(instText(sessionA.root!)).toContain("2 events");
    expect(instText(sessionB.root!)).toContain("2 events");

    // Session A completes a privileged action. The server state changes, but
    // already-rendered audit-log snapshots do not update without a refresh.
    sharedAuditRows.unshift(auditRow(102, "target-created-in-session-a", "ban"));
    expect(instText(sessionB.root!)).toContain("2 events");
    expect(instText(sessionB.root!)).not.toContain("target-created-in-session-a");

    const refresh = findPressableByAccessibilityLabel(sessionB.root!, "Refresh");
    expect(refresh).not.toBeNull();
    expect(refresh!.props.accessibilityHint).toBe(
      "Reload audit events to include actions from other admin sessions",
    );

    await act(async () => {
      fireEvent.press(refresh!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(requestTokens).toEqual([
      "Bearer admin-session-a",
      "Bearer admin-session-b",
      "Bearer admin-session-b",
    ]);
    expect(instText(sessionB.root!)).toContain("3 events");
    expect(accessibilityLabels(sessionB.root!)).toContain(
      "Target ID: target-created-in-session-a",
    );
    expect(instText(sessionA.root!)).toContain("2 events");

    await act(async () => {
      sessionA.unmount();
    });
    await act(async () => {
      sessionB.unmount();
    });
  });
});
