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

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderScreen() {
  useApp.mockReturnValue({
    isAdmin: true,
    adminToken: "admin-token-abc",
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
      { headers: { Authorization: "Bearer admin-token-abc" } },
    );
    expect(instText(screen.root!)).toContain("2 events+");

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
      { headers: { Authorization: "Bearer admin-token-abc" } },
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
      { headers: { Authorization: "Bearer admin-token-abc" } },
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
      .mockResolvedValueOnce(jsonResponse(firstPage));

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

    await act(async () => {
      fireEvent.press(findPressable(screen.root!, "Retry")!);
      await Promise.resolve();
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3001/api/admin/audit-log?limit=50",
      { headers: { Authorization: "Bearer admin-token-abc" } },
    );
    expect(instText(screen.root!)).toContain("2 events+");
    expect(instText(screen.root!)).not.toContain("Server error 503");

    const targets = renderedTargets(screen.root!);
    expect(targets).toEqual(["target-newest", "target-next"]);
    expect(new Set(targets).size).toBe(targets.length);

    await act(async () => {
      screen.unmount();
    });
  });
});