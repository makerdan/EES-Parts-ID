/**
 * Regression tests for AddPartForm:
 *   1. Save-and-unmount safety — no setState warning when the component is
 *      unmounted before the async fetch resolves.
 *   2. Rollback path — error state is set when the server returns an error
 *      and the component is still mounted.
 *
 * Uses @testing-library/react-native + act() following the makeAppMock pattern used
 * in nearby tests.
 */

// Required for act() to work correctly in the node test environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { render, act, fireEvent } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";
import { AddPartForm } from "@/components/AddPartForm";
import { makeAppMock } from "./helpers/appMocks";

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("@/contexts/AppContext");

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: (props: Record<string, unknown>) =>
    React.createElement("TextInput", {
      ...props,
      testID: props.placeholder ?? "input",
    }),
}));

jest.mock("@/components/PartPhotoPicker", () => ({
  PartPhotoPicker: () => null,
}));

jest.mock("@/components/MeasurePartScreen", () => ({
  MeasurePartScreen: () => null,
}));

jest.mock("expo-file-system/legacy", () => ({
  readAsStringAsync: jest.fn().mockResolvedValue("base64data"),
}));

jest.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

jest.mock("@/utils/apiBase", () => ({
  API_BASE: "http://localhost:8080/api",
  API_ORIGIN: "http://localhost:8080",
}));

// ─── AppContext mock setup ────────────────────────────────────────────────────

const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ─── Per-test setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  useApp.mockReturnValue(makeAppMock());
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function renderForm(props: React.ComponentProps<typeof AddPartForm>) {
  return await render(React.createElement(AddPartForm, props));
}

function fillRequiredFields(result: Awaited<ReturnType<typeof render>>) {
  const root = result.root!;
  const catalogInput = root.queryAll(
    (n: TestInstance) => String(n.props?.placeholder ?? "").includes("BR120"),
    { includeSelf: true },
  )[0];
  if (catalogInput) catalogInput.props.onChangeText("WIDGET-42");

  const vendorInput = root.queryAll(
    (n: TestInstance) => String(n.props?.placeholder ?? "").includes("EATON"),
    { includeSelf: true },
  )[0];
  if (vendorInput) vendorInput.props.onChangeText("ACME");

  const binInput = root.queryAll(
    (n: TestInstance) => String(n.props?.placeholder ?? "").includes("01-05-210"),
    { includeSelf: true },
  )[0];
  if (binInput) binInput.props.onChangeText("01-02-100");
}

function getAllTextStrings(root: TestInstance): string[] {
  const texts: string[] = [];
  function traverse(node: TestInstance) {
    for (const child of node.children ?? []) {
      if (typeof child === "string") {
        texts.push(child);
      } else if (child && typeof child === "object" && "children" in child) {
        traverse(child as TestInstance);
      }
    }
  }
  traverse(root);
  return texts;
}

function findSubmitButton(result: Awaited<ReturnType<typeof render>>) {
  const root = result.root!;
  return root
    .queryAll((n: TestInstance) => (n.type as string) === "rn-pressable", { includeSelf: true })
    .find((n) => {
      const flat = n.queryAll((c: TestInstance) => typeof c.children?.[0] === "string", { includeSelf: true });
      return flat.some((c) => String(c.children?.[0] ?? "").includes("Add Part"));
    }) ?? null;
}

// =============================================================================
// 1. Save-and-unmount: no setState warning
// =============================================================================

describe("AddPartForm — save-and-unmount (isMounted guard)", () => {
  it("does not emit a setState-on-unmounted-component warning when the component is unmounted before fetch resolves", async () => {
    let resolveCreate!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((res) => { resolveCreate = res; });
    global.fetch = jest.fn().mockReturnValue(pendingFetch) as jest.Mock;

    const consoleSpy = jest.spyOn(console, "error");
    consoleSpy.mockClear();

    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });

    // Fill required fields then submit.
    await act(async () => { fillRequiredFields(result); });
    const submitBtn = findSubmitButton(result);
    expect(submitBtn).not.toBeNull();
    await act(async () => { fireEvent.press(submitBtn!); });

    // Unmount the component BEFORE the fetch resolves.
    await act(async () => { result.unmount(); });

    // Now resolve the fetch — triggers the async continuation with isMounted=false.
    resolveCreate({
      ok: true,
      status: 200,
      json: async () => ({ item: { id: 1, vendor: "ACME", catalog: "WIDGET-42", binLocations: [], aiKeywords: [], imageUrl: null } }),
    } as unknown as Response);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // No "Can't perform a React state update on an unmounted component" warning.
    const stateUpdateWarning = consoleSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("unmounted component"),
    );
    expect(stateUpdateWarning).toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("does not emit a setState warning when unmounted before an error response resolves", async () => {
    let resolveCreate!: (value: Response) => void;
    const pendingFetch = new Promise<Response>((res) => { resolveCreate = res; });
    global.fetch = jest.fn().mockReturnValue(pendingFetch) as jest.Mock;

    const consoleSpy = jest.spyOn(console, "error");
    consoleSpy.mockClear();

    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });

    await act(async () => { fillRequiredFields(result); });
    const submitBtn = findSubmitButton(result);
    await act(async () => { fireEvent.press(submitBtn!); });

    await act(async () => { result.unmount(); });

    resolveCreate({
      ok: false,
      status: 409,
      json: async () => ({ error: "Already exists." }),
    } as unknown as Response);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const stateUpdateWarning = consoleSpy.mock.calls.find(
      ([msg]) => typeof msg === "string" && msg.includes("unmounted component"),
    );
    expect(stateUpdateWarning).toBeUndefined();
    consoleSpy.mockRestore();
  });
});

// =============================================================================
// 2. Rollback path — error state is set correctly when still mounted
// =============================================================================

describe("AddPartForm — error rollback (still mounted)", () => {
  it("sets an error message when the server returns 409 Conflict and the component is still mounted", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "A part with this vendor and catalog number already exists." }),
    } as unknown as Response) as jest.Mock;

    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });

    await act(async () => { fillRequiredFields(result); });
    const submitBtn = findSubmitButton(result);
    expect(submitBtn).not.toBeNull();
    await act(async () => { fireEvent.press(submitBtn!); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { await Promise.resolve(); });
    }

    const allTexts = getAllTextStrings(result.root!);
    const errorText = allTexts.find((t) => t.includes("already exists") || t.includes("vendor") || t.includes("catalog"));
    expect(errorText).toBeDefined();

    result.unmount();
  });

  it("sets a network error message when fetch rejects and the component is still mounted", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network failure")) as jest.Mock;

    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });

    await act(async () => { fillRequiredFields(result); });
    const submitBtn = findSubmitButton(result);
    expect(submitBtn).not.toBeNull();
    await act(async () => { fireEvent.press(submitBtn!); });
    for (let i = 0; i < 5; i++) {
      await act(async () => { await Promise.resolve(); });
    }

    const allTexts = getAllTextStrings(result.root!);
    const errorText = allTexts.find((t) => t.toLowerCase().includes("network") || t.toLowerCase().includes("connection") || t.toLowerCase().includes("error"));
    expect(errorText).toBeDefined();

    result.unmount();
  });
});
