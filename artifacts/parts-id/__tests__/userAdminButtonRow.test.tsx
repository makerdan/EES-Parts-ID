/**
 * @jest-environment node
 *
 * UI-level guard tests for UserAdminButtonRow.
 *
 * The server-side /admin/users/:id/promote endpoint returns 400 for non-approved
 * users, but the UI guard is the first line of defence: the "Make Admin" button
 * must never render for a pending or banned user, regardless of their role field.
 *
 * Scenarios covered:
 *   A) pending user, role=user   → no "Make Admin" button
 *   B) banned user, role=user    → no "Make Admin" button
 *   C) approved user, role=user  → "Make Admin" button IS rendered
 *   D) approved user, role=admin → "Revoke Admin" button (not "Make Admin")
 *   E) pending user, role=admin  → "Revoke Admin" button (admin role takes precedence)
 */

// Required for act() in node test environment.
// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import renderer, { act } from "react-test-renderer";

import { UserAdminButtonRow } from "../components/UserAdminButtonRow";
import type { UserRow } from "../utils/adminUserActions";

// ─── @/hooks/useColors ────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Suppress react-test-renderer deprecation noise ──────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") ||
          msg.includes("Warning:"))
      )
        return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore?.();
});

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => {
      activeTree!.unmount();
    });
    activeTree = null;
  }
  jest.clearAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    clerkUserId: "user_test",
    email: "test@example.com",
    status: "pending",
    role: "user",
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── Render helper ────────────────────────────────────────────────────────────

async function renderRow(props: {
  user: UserRow;
  userActionPending?: string | null;
  onPromote?: () => void;
  onDemote?: () => void;
}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <UserAdminButtonRow
        user={props.user}
        userActionPending={props.userActionPending ?? null}
        onPromote={props.onPromote ?? jest.fn()}
        onDemote={props.onDemote ?? jest.fn()}
      />,
    );
  });
  activeTree = tree;
  return tree;
}

function findMakeAdminButton(root: renderer.ReactTestInstance) {
  return root.findAll(
    (n) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Make Admin",
    { deep: true },
  );
}

function findRevokeAdminButton(root: renderer.ReactTestInstance) {
  return root.findAll(
    (n) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Revoke Admin",
    { deep: true },
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("UserAdminButtonRow — Make Admin button guard", () => {
  it("(A) does NOT render Make Admin for a pending user", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "pending", role: "user" }),
    });
    expect(findMakeAdminButton(tree.root)).toHaveLength(0);
  });

  it("(B) does NOT render Make Admin for a banned user", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "banned", role: "user" }),
    });
    expect(findMakeAdminButton(tree.root)).toHaveLength(0);
  });

  it("(C) renders Make Admin for an approved non-admin user", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
    });
    expect(findMakeAdminButton(tree.root)).toHaveLength(1);
  });

  it("(D) renders Revoke Admin (not Make Admin) for an approved admin user", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "approved", role: "admin" }),
    });
    expect(findMakeAdminButton(tree.root)).toHaveLength(0);
    expect(findRevokeAdminButton(tree.root)).toHaveLength(1);
  });

  it("(E) admin role takes precedence — shows Revoke Admin even for a pending admin", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "pending", role: "admin" }),
    });
    expect(findMakeAdminButton(tree.root)).toHaveLength(0);
    expect(findRevokeAdminButton(tree.root)).toHaveLength(1);
  });
});

describe("UserAdminButtonRow — button disabled state", () => {
  it("Make Admin button is disabled when another action is in progress", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
      userActionPending: "some_other_user",
    });
    const [btn] = findMakeAdminButton(tree.root);
    expect(btn!.props.disabled).toBe(true);
  });

  it("Revoke Admin button is disabled when another action is in progress", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "approved", role: "admin" }),
      userActionPending: "some_other_user",
    });
    const [btn] = findRevokeAdminButton(tree.root);
    expect(btn!.props.disabled).toBe(true);
  });

  it("Make Admin button is enabled when no action is pending", async () => {
    const tree = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
      userActionPending: null,
    });
    const [btn] = findMakeAdminButton(tree.root);
    expect(btn!.props.disabled).toBe(false);
  });
});
