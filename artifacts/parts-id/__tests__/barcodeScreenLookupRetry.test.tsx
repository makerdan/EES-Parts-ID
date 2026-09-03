/**
 * Regression coverage for BarcodeScreen's failed lookup recovery.
 *
 * A rejected barcode lookup must leave the loading state, show the actionable
 * retry banner, and allow the same barcode to be retried without scanning it
 * again. A successful retry must render the found state and clear the error.
 */

(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";

// ── Native and app dependencies ──────────────────────────────────────────────

jest.mock("expo-camera", () => {
  const R = require("react") as typeof React;
  const permission = { granted: true, canAskAgain: true };
  const requestPermission = jest.fn();

  return {
    CameraView: ({
      children,
      ...props
    }: { children?: React.ReactNode; [key: string]: unknown }) =>
      R.createElement("mock-camera", props, children),
    useCameraPermissions: jest.fn(() => [permission, requestPermission]),
  };
});

jest.mock("@workspace/api-client-react", () => ({
  lookupByBarcode: jest.fn(),
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn() })),
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock("expo-router", () => ({
  router: { navigate: jest.fn() },
}));

jest.mock("@/hooks/useScanHistory", () => {
  const addEntry = jest.fn().mockResolvedValue(undefined);
  const clear = jest.fn();
  return {
    useScanHistory: jest.fn(() => ({ history: [], addEntry, clear })),
  };
});

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff",
    foreground: "#111",
    card: "#f9f9f9",
    border: "#ddd",
    primary: "#007aff",
    primaryForeground: "#fff",
    muted: "#f0f0f0",
    mutedForeground: "#888",
    success: "#10b981",
    successForeground: "#fff",
    destructive: "#ef4444",
    warning: "#f59e0b",
    warningForeground: "#fff",
  }),
}));

jest.mock("@/components/CatalogPickerModal", () => ({
  CatalogPickerModal: () => null,
}));
jest.mock("@/components/PartDetailsEditor", () => ({
  PartDetailsEditor: () => null,
}));
jest.mock("@/components/ResultCard", () => ({
  ResultCard: () => null,
}));

jest.mock("@/utils/barcodeResolver", () => ({
  resolveBarcodeCode: jest.fn(),
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/offlineBarcode", () => ({
  FUSE_SYNC_MAX_AGE_MS: 72 * 60 * 60 * 1000,
  getFuseCacheSyncedAt: jest.fn().mockResolvedValue(null),
  lookupByBarcodeOffline: jest.fn().mockResolvedValue(null),
  upsertItemInBarcodeCache: jest.fn().mockResolvedValue(undefined),
}));

// ── Subject and test seams ───────────────────────────────────────────────────

import BarcodeScreen from "@/components/BarcodeScreen";

const { resolveBarcodeCode } = require("@/utils/barcodeResolver") as {
  resolveBarcodeCode: jest.Mock;
};
const { useApp } = require("@/contexts/AppContext") as {
  useApp: jest.Mock;
};

type TestInstance = NonNullable<RenderResult["root"]>;

const BARCODE = "0123456789012";
const ITEM = {
  id: 42,
  catalog: "WIDGET-42",
  vendor: "ACME",
  description: "Recovered item",
  binLocations: [],
  barcodes: [BARCODE],
};

function instanceText(node: TestInstance | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? [])
    .map((child) => instanceText(child as TestInstance | string))
    .join("");
}

function findPressableContaining(root: TestInstance, text: string): TestInstance | null {
  return (
    root.queryAll(
      (node) =>
        String(node.type) === "rn-pressable" &&
        instanceText(node).includes(text),
      { includeSelf: true },
    )[0] ?? null
  );
}

function findTextContaining(root: TestInstance, text: string): TestInstance[] {
  return root.queryAll(
    (node) =>
      String(node.type) === "Text" &&
      instanceText(node).includes(text),
    { includeSelf: true },
  );
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let rendered: RenderResult | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  resolveBarcodeCode.mockReset();
  useApp.mockReturnValue({
    isAdmin: false,
    adminToken: null,
    textFontScale: 1,
    settings: { themeMode: "light" },
    setPinnedParts: jest.fn(),
    showToast: jest.fn(),
  });
});

afterEach(async () => {
  if (rendered) {
    await rendered.unmount();
    rendered = null;
  }
});

describe("BarcodeScreen lookup failure recovery", () => {
  it("shows the error banner, retries the same code, and renders the found state", async () => {
    resolveBarcodeCode.mockRejectedValueOnce(new Error("network down"));

    await act(async () => {
      rendered = await render(<BarcodeScreen />);
    });

    const root = rendered!.root!;
    const camera = root.queryAll(
      (node) => String(node.type) === "mock-camera",
      { includeSelf: true },
    )[0];
    expect(camera).toBeDefined();

    await act(async () => {
      camera!.props.onBarcodeScanned({ data: BARCODE });
    });

    const scanButton = findPressableContaining(root, "⬤  Scan");
    expect(scanButton).not.toBeNull();

    await act(async () => {
      scanButton!.props.onPress();
    });
    await flushAsyncWork();

    expect(resolveBarcodeCode).toHaveBeenCalledTimes(1);
    expect(resolveBarcodeCode).toHaveBeenCalledWith(BARCODE);
    expect(findTextContaining(root, "Lookup failed — tap to retry")).toHaveLength(1);
    expect(findTextContaining(root, "Looking up…")).toHaveLength(0);

    resolveBarcodeCode.mockResolvedValueOnce({
      phase: "found",
      item: ITEM,
      isOffline: false,
    });

    const retryBanner = findPressableContaining(
      root,
      "Lookup failed — tap to retry",
    );
    expect(retryBanner).not.toBeNull();

    await act(async () => {
      retryBanner!.props.onPress();
    });
    await flushAsyncWork();

    expect(resolveBarcodeCode).toHaveBeenCalledTimes(2);
    expect(resolveBarcodeCode).toHaveBeenNthCalledWith(2, BARCODE);
    expect(findTextContaining(root, "Lookup failed — tap to retry")).toHaveLength(0);
    expect(findTextContaining(root, "Looking up…")).toHaveLength(0);
    expect(findTextContaining(root, "SCAN RESULT")).toHaveLength(1);
    expect(findTextContaining(root, `Code: ${BARCODE}`)).toHaveLength(1);
  });
});