/**
 * Lifecycle regression for BulkShelfAssign.
 *
 * A native camera callback can complete after the modal has been closed.
 * That completion must not update a row, show a toast, trigger success
 * feedback, or transition the closed modal to its completion animation.
 */

// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import { act, render } from "@testing-library/react-native";
import type { RenderResult } from "@testing-library/react-native";
import type { TestInstance } from "test-renderer";

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
const mockShowToast = jest.fn();
const mockResolveShelfAssign = jest.fn<Promise<{ wasNew: boolean }>, [string, unknown, unknown, unknown]>();
const mockInvalidateListIfNew = jest.fn().mockResolvedValue(undefined);
const mockNotificationAsync = jest.fn().mockResolvedValue(undefined);

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: (...args: [string]) => mockGetItem(...args),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("expo-camera", () => {
  const R = require("react");
  return {
    CameraView: (props: Record<string, unknown>) => R.createElement("rn-camera", props),
    useCameraPermissions: jest.fn(() => [{ granted: true, canAskAgain: true }, jest.fn()]),
  };
});


jest.mock("expo-haptics", () => ({
  notificationAsync: (...args: unknown[]) => mockNotificationAsync(...args),
  NotificationFeedbackType: { Success: "Success" },
}));

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock("@workspace/api-client-react", () => ({
  listInventory: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  useListInventory: jest.fn(() => ({ data: null })),
  useUpdateItemBarcodes: jest.fn(() => ({ mutateAsync: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ showToast: mockShowToast }),
}));
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
    destructive: "#ef4444",
    warning: "#f59e0b",
  }),
}));
jest.mock("@/components/DismissKeyboard", () => ({
  DismissKeyboard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/utils/barcodeResolver", () => ({
  resolveShelfAssign: (...args: [string, unknown, unknown, unknown]) => mockResolveShelfAssign(...args),
}));
jest.mock("@/utils/listEditorHandlers", () => ({
  invalidateListIfNew: (...args: [{ queryClient: unknown; wasNew: boolean }]) => mockInvalidateListIfNew(...args),
  undoBarcodeAndInvalidate: jest.fn(),
}));
jest.mock("@/utils/offlineBarcode", () => ({
  upsertItemInBarcodeCache: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/utils/storageErrorReporter", () => ({
  reportStorageError: jest.fn(),
}));

import { BulkShelfAssign } from "../BulkShelfAssign";

type Inst = TestInstance;
type Root = NonNullable<RenderResult["root"]>;

const BULK_KEY = "parts_id_bulk_shelf_session_v1";
const BARCODE_KEY = "parts_id_shelf_session_v1";
const item = {
  id: 7,
  catalog: "PART-007",
  vendor: "ACME",
  binLocations: ["01-02-100"],
  barcodes: [],
};
const resumeSession = JSON.stringify({
  shelfPrefix: "01-02",
  shelfItems: [item],
  itemRowStates: {},
  targetItemId: null,
});

function allText(root: Root): string {
  return root.queryAll((node: Inst) => node.type === "Text", { includeSelf: true })
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === "string")
    .join(" ");
}

function findByType(root: Root, type: string): Inst {
  const match = root.queryAll((node: Inst) => node.type === type, { includeSelf: true })[0];
  if (!match) throw new Error(`Expected ${type} in rendered tree`);
  return match;
}

function BulkShelfAssignHarness({ onClose }: { onClose: jest.Mock }) {
  const [visible, setVisible] = React.useState(true);
  return (
    <BulkShelfAssign
      visible={visible}
      onClose={() => {
        onClose();
        setVisible(false);
      }}
    />
  );
}

describe("BulkShelfAssign — assignment completion after close", () => {
  let tree: RenderResult | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockImplementation((key: string) =>
      Promise.resolve(key === BULK_KEY ? resumeSession : key === BARCODE_KEY ? null : null),
    );
    mockResolveShelfAssign.mockImplementation(
      () => new Promise<{ wasNew: boolean }>(() => {}),
    );
  });

  afterEach(async () => {
    if (tree) {
      await tree.unmount();
      tree = null;
    }
  });

  it("ignores a delayed native assignment completion after Close", async () => {
    let resolveAssignment!: (value: { wasNew: boolean }) => void;
    mockResolveShelfAssign.mockImplementation(
      () => new Promise(resolve => { resolveAssignment = resolve; }),
    );

    const onClose = jest.fn();
    await act(async () => {
      tree = await render(<BulkShelfAssignHarness onClose={onClose} />);
    });
    await act(async () => {});

    const root = tree!.root!;
    const resume = root.queryAll((node: Inst) =>
      node.type === "rn-pressable" &&
      node.queryAll((child: Inst) => child.type === "Text", { includeSelf: true })
        .some(child => child.children.includes("Resume")),
      { includeSelf: true },
    )[0];
    if (!resume) throw new Error("Expected Resume button");
    await act(async () => { resume.props.onPress(); });

    const startCamera = tree!.root!.queryAll((node: Inst) =>
      node.type === "rn-pressable" &&
      node.queryAll((child: Inst) => child.type === "Text", { includeSelf: true })
        .some(child => child.children.includes("📷 Start Camera")),
      { includeSelf: true },
    )[0];
    if (!startCamera) throw new Error("Expected Start Camera button");
    await act(async () => { startCamera.props.onPress(); });

    const camera = findByType(tree!.root!, "rn-camera");
    await act(async () => {
      camera.props.onBarcodeScanned({ data: "BARCODE-007" });
    });

    expect(mockResolveShelfAssign).toHaveBeenCalledTimes(1);
    expect(allText(tree!.root!)).toContain("Assigning");

    const close = tree!.root!.queryAll((node: Inst) =>
      node.type === "rn-pressable" &&
      node.queryAll((child: Inst) => child.type === "Text", { includeSelf: true })
        .some(child => child.children.includes("Close")),
      { includeSelf: true },
    )[0];
    if (!close) throw new Error("Expected Close button");
    await act(async () => { close.props.onPress(); });
    expect(onClose).toHaveBeenCalledTimes(1);

    resolveAssignment({ wasNew: true });
    await act(async () => {});
    await act(async () => {});

    const closedText = tree!.root ? allText(tree!.root) : "";
    expect(tree!.root).toBeUndefined();
    expect(closedText).not.toContain("✓ Assigned");
    expect(closedText).not.toContain("BARCODE-007");
    expect(closedText).not.toContain("Shelf Complete");
    expect(closedText).not.toContain("Done —");
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(mockNotificationAsync).not.toHaveBeenCalled();
  });
});