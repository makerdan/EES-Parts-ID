/**
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
import { render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

import { UserAdminButtonRow } from "../components/UserAdminButtonRow";
import type { UserRow } from "../utils/adminUserActions";

// ─── @/hooks/useColors ────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ─── Per-test teardown ────────────────────────────────────────────────────────

let activeTree: RenderResult | null = null;

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
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

type Inst = TestInstance | null | undefined;

async function renderRow(props: {
  user: UserRow;
  userActionPending?: string | null;
  onPromote?: () => void;
  onDemote?: () => void;
}) {
  const result = await render(
    <UserAdminButtonRow
      user={props.user}
      userActionPending={props.userActionPending ?? null}
      onPromote={props.onPromote ?? jest.fn()}
      onDemote={props.onDemote ?? jest.fn()}
    />,
  );
  activeTree = result;
  return result;
}

function findMakeAdminButton(root: Inst) {
  if (!root) return [];
  return root.queryAll(
    (n: TestInstance) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Make Admin",
    { includeSelf: true },
  );
}

function findRevokeAdminButton(root: Inst) {
  if (!root) return [];
  return root.queryAll(
    (n: TestInstance) =>
      (n.type as string) === "rn-pressable" &&
      n.props.accessibilityLabel === "Revoke Admin",
    { includeSelf: true },
  );
}

// =============================================================================
// Tests
// =============================================================================

describe("UserAdminButtonRow — Make Admin button guard", () => {
  it("(A) does NOT render Make Admin for a pending user", async () => {
    const result = await renderRow({
      user: makeUser({ status: "pending", role: "user" }),
    });
    expect(findMakeAdminButton(result.root)).toHaveLength(0);
  });

  it("(B) does NOT render Make Admin for a banned user", async () => {
    const result = await renderRow({
      user: makeUser({ status: "banned", role: "user" }),
    });
    expect(findMakeAdminButton(result.root)).toHaveLength(0);
  });

  it("(C) renders Make Admin for an approved non-admin user", async () => {
    const result = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
    });
    expect(findMakeAdminButton(result.root)).toHaveLength(1);
  });

  it("(D) renders Revoke Admin (not Make Admin) for an approved admin user", async () => {
    const result = await renderRow({
      user: makeUser({ status: "approved", role: "admin" }),
    });
    expect(findMakeAdminButton(result.root)).toHaveLength(0);
    expect(findRevokeAdminButton(result.root)).toHaveLength(1);
  });

  it("(E) admin role takes precedence — shows Revoke Admin even for a pending admin", async () => {
    const result = await renderRow({
      user: makeUser({ status: "pending", role: "admin" }),
    });
    expect(findMakeAdminButton(result.root)).toHaveLength(0);
    expect(findRevokeAdminButton(result.root)).toHaveLength(1);
  });
});

describe("UserAdminButtonRow — button disabled state", () => {
  it("Make Admin button is disabled when another action is in progress", async () => {
    const result = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
      userActionPending: "some_other_user",
    });
    const [btn] = findMakeAdminButton(result.root);
    expect(btn!.props.disabled).toBe(true);
  });

  it("Revoke Admin button is disabled when another action is in progress", async () => {
    const result = await renderRow({
      user: makeUser({ status: "approved", role: "admin" }),
      userActionPending: "some_other_user",
    });
    const [btn] = findRevokeAdminButton(result.root);
    expect(btn!.props.disabled).toBe(true);
  });

  it("Make Admin button is enabled when no action is pending", async () => {
    const result = await renderRow({
      user: makeUser({ status: "approved", role: "user" }),
      userActionPending: null,
    });
    const [btn] = findMakeAdminButton(result.root);
    expect(btn!.props.disabled).toBe(false);
  });
});
