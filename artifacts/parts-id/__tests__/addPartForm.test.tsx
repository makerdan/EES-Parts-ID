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

function findDimensionInput(result: Awaited<ReturnType<typeof render>>, label: string) {
  return result.root!.queryAll(
    (n: TestInstance) => n.props.accessibilityLabel === label,
    { includeSelf: true },
  )[0] ?? null;
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

describe("AddPartForm — dimension validation", () => {
  it.each([
    { rollback: { ok: true, status: 204 }, expected: "The part was not created. Please try again." },
    { rollback: { ok: false, status: 500 }, expected: "The part was created, but cleanup failed." },
  ])("reports the actual rollback outcome ($rollback.status)", async ({ rollback, expected }) => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ item: { id: 7, vendor: "ACME", catalog: "WIDGET-42" } }),
      })
      .mockResolvedValueOnce({
        ok: false, status: 500, json: async () => ({ error: "Dimensions unavailable" }),
      })
      .mockResolvedValueOnce(rollback) as jest.Mock;
    const onSuccess = jest.fn();
    const result = await renderForm({ adminToken: "test-token", onSuccess });
    await act(async () => { fillRequiredFields(result); });
    await act(async () => { await fireEvent.changeText(findDimensionInput(result, "Length")!, "12"); });
    await act(async () => { await fireEvent.press(findSubmitButton(result)!); });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect((global.fetch as jest.Mock).mock.calls[2]?.[1]?.method).toBe("DELETE");
    expect(getAllTextStrings(result.root!).join(" ")).toContain(expected);
    expect(onSuccess).not.toHaveBeenCalled();
    await result.unmount();
  });

  it("warns that the part may remain when rollback DELETE throws", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ item: { id: 7 } }) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockRejectedValueOnce(new Error("offline")) as jest.Mock;
    const result = await renderForm({ adminToken: "test-token", onSuccess: jest.fn() });
    await act(async () => { fillRequiredFields(result); });
    await act(async () => { await fireEvent.changeText(findDimensionInput(result, "Length")!, "12"); });
    await act(async () => { await fireEvent.press(findSubmitButton(result)!); });
    expect(getAllTextStrings(result.root!).join(" ")).toContain("The part was created, but cleanup failed.");
    await result.unmount();
  });

  it.each(["-12.5", "1..2", "100001"])(
    "keeps invalid dimension text %s visible and blocks part creation",
    async (value) => {
      global.fetch = jest.fn() as jest.Mock;
      const result = await renderForm({
        adminToken: "test-token",
        onSuccess: jest.fn(),
      });
      await act(async () => { fillRequiredFields(result); });

      const lengthInput = findDimensionInput(result, "Length");
      expect(lengthInput).not.toBeNull();
      await act(async () => { fireEvent.changeText(lengthInput!, value); });
      await act(async () => { fireEvent.press(findSubmitButton(result)!); });

      const updatedLength = findDimensionInput(result, "Length");
      expect(updatedLength?.props.value).toBe(value);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(getAllTextStrings(result.root!).join(" ")).toContain("Enter a non-negative number up to 100,000");
      await result.unmount();
    },
  );

  it("saves a valid decimal to one decimal place and sends blank dimensions as null", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          item: {
            id: 7,
            vendor: "ACME",
            catalog: "WIDGET-42",
            binLocations: [],
            aiKeywords: [],
            imageUrl: null,
            imageUrl2: null,
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response) as jest.Mock;
    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });
    await act(async () => { fillRequiredFields(result); });

    await act(async () => {
      fireEvent.changeText(findDimensionInput(result, "Length")!, "12.34");
    });
    await act(async () => { fireEvent.press(findSubmitButton(result)!); });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[1]![1].body)).toEqual({
      length: 12.3,
      width: null,
      height: null,
      diameter: null,
    });
    await result.unmount();
  });

  it("omits the dimensions request when every dimension field is blank", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        item: {
          id: 8,
          vendor: "ACME",
          catalog: "WIDGET-42",
          binLocations: [],
          aiKeywords: [],
          imageUrl: null,
          imageUrl2: null,
        },
      }),
    } as unknown as Response) as jest.Mock;
    const result = await renderForm({
      adminToken: "test-token",
      onSuccess: jest.fn(),
    });
    await act(async () => { fillRequiredFields(result); });
    await act(async () => { fireEvent.press(findSubmitButton(result)!); });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    await result.unmount();
  });
});
