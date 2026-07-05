/**
 * @jest-environment node
 *
 * Verifies that CatalogPdfUpload attaches a window.beforeunload handler when
 * an upload is in progress on web, and removes it when the upload finishes.
 */

// @ts-ignore — required for act() to work correctly in the node environment
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ────────────────────────────────────────────────────────────────

const mockNavigationAddListener = jest.fn(() => jest.fn());
const mockNavigationDispatch = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useNavigation: () => ({
    addListener: mockNavigationAddListener,
    dispatch: mockNavigationDispatch,
  }),
}));

// ── expo-document-picker ──────────────────────────────────────────────────────

const mockGetDocumentAsync = jest.fn();

jest.mock("expo-document-picker", () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

// ── expo-keep-awake ───────────────────────────────────────────────────────────

jest.mock("expo-keep-awake", () => ({
  activateKeepAwake: jest.fn(),
  deactivateKeepAwake: jest.fn(),
}));

// ── expo-file-system/legacy ───────────────────────────────────────────────────

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///mock-cache/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
  FileSystemSessionType: { BACKGROUND: "BACKGROUND" },
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  createUploadTask: jest.fn(),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 512 }),
  readAsStringAsync: jest.fn().mockResolvedValue(""),
}));

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ── @/utils/readPdfAsBase64 ────────────────────────────────────────────────────

const mockReadPdfAsBytes = jest.fn<Promise<Uint8Array>, [string, File?]>();

jest.mock("@/utils/readPdfAsBase64", () => ({
  readPdfAsBytes: (...args: unknown[]) =>
    mockReadPdfAsBytes(...(args as [string, File?])),
  toFriendlyReadError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)),
  InvalidPdfError: class InvalidPdfError extends Error {
    constructor() { super("The selected file is not a valid PDF."); this.name = "InvalidPdfError"; }
  },
  EncryptedPdfError: class EncryptedPdfError extends Error {
    constructor() { super("Password-protected PDFs are not supported."); this.name = "EncryptedPdfError"; }
  },
  PdfTooLargeError: class PdfTooLargeError extends Error {
    constructor() { super("PDF is too large (max 25 MB)."); this.name = "PdfTooLargeError"; }
  },
  MAX_PDF_BYTES: 25 * 1024 * 1024,
}));

// ── @/utils/splitPdfIntoChunks ────────────────────────────────────────────────

jest.mock("@/utils/splitPdfIntoChunks", () => ({
  splitPdfIntoChunks: jest.fn(),
  getOrSplitChunks: jest.fn(async (cached: unknown, bytes: unknown, _ppc: unknown, splitFn: unknown) => {
    if (cached !== null) return cached;
    return (splitFn as (b: unknown, n: unknown) => Promise<unknown>)(bytes, 20);
  }),
  PAGES_PER_CHUNK: 20,
}));

// ── @/utils/aiFallbackHeaders ─────────────────────────────────────────────────

jest.mock("@/utils/aiFallbackHeaders", () => ({
  shouldUseFallback: jest.fn(() => false),
}));

// ── @/components/KeyboardDoneInput ────────────────────────────────────────────

let capturedOnChangeText: ((v: string) => void) | null = null;

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: (props: { onChangeText?: (v: string) => void; [k: string]: unknown }) => {
    capturedOnChangeText = props.onChangeText ?? null;
    return null;
  },
}));

// ── Suppress react-test-renderer deprecation warnings ─────────────────────────

let origConsoleError: typeof console.error;
beforeAll(() => {
  origConsoleError = console.error.bind(console);
  jest.spyOn(console, "error").mockImplementation(
    (msg: unknown, ...args: unknown[]) => {
      if (
        typeof msg === "string" &&
        (msg.includes("react-test-renderer is deprecated") || msg.includes("Warning:") || msg.includes("act("))
      ) return;
      origConsoleError(msg, ...args);
    },
  );
});
afterAll(() => { (console.error as jest.Mock).mockRestore?.(); });

// ── Imports (after all jest.mock declarations) ────────────────────────────────

import React from "react";
import renderer, { act } from "react-test-renderer";
import { CatalogPdfUpload } from "../components/CatalogPdfUpload";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
function makePdfBytes(): Uint8Array { return PDF_MAGIC; }
function makeFile(bytes: Uint8Array): File {
  return new File([bytes.buffer as ArrayBuffer], "catalog.pdf", { type: "application/pdf" });
}

type Inst = renderer.ReactTestInstance;
function instText(node: Inst | string): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map((c) => instText(c as Inst | string)).join("");
}
function findPressable(root: Inst, label: string): Inst | null {
  return (
    root
      .findAll((n) => (n.type as string) === "rn-pressable", { deep: true })
      .find((n) => instText(n).includes(label)) ?? null
  );
}
const flushPromises = () =>
  act(async () => {
    await new Promise<void>((res) => setTimeout(res, 0));
    await new Promise<void>((res) => setTimeout(res, 0));
    await new Promise<void>((res) => setTimeout(res, 0));
  });

// ── XHR mock ──────────────────────────────────────────────────────────────────

type XhrEventName = "load" | "error" | "abort";
interface MockXhr {
  open: jest.Mock;
  setRequestHeader: jest.Mock;
  send: jest.Mock;
  abort: jest.Mock;
  status: number;
  responseText: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  upload: { onprogress: ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  fireEvent(name: XhrEventName): void;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("CatalogPdfUpload — beforeunload guard on web", () => {
  let originalPlatformOS: string;
  let mockXhr: MockXhr;
  let mockAddEventListener: jest.Mock;
  let mockRemoveEventListener: jest.Mock;
  let activeTree: renderer.ReactTestRenderer | null = null;

  beforeEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    originalPlatformOS = Platform.OS;
    (Platform as { OS: string }).OS = "web";

    mockXhr = {
      open: jest.fn(),
      setRequestHeader: jest.fn(),
      send: jest.fn(),
      abort: jest.fn(),
      status: 200,
      responseText: "",
      onload: null,
      onerror: null,
      onabort: null,
      upload: { onprogress: null },
      fireEvent(name: XhrEventName) {
        const handler = this[`on${name}`] as (() => void) | null;
        if (handler) handler.call(this);
      },
    };
    (global as unknown as { XMLHttpRequest: jest.Mock }).XMLHttpRequest = jest.fn(() => mockXhr);

    mockAddEventListener = jest.fn();
    mockRemoveEventListener = jest.fn();
    (global as unknown as { window: { addEventListener: jest.Mock; removeEventListener: jest.Mock } }).window = {
      addEventListener: mockAddEventListener,
      removeEventListener: mockRemoveEventListener,
    };
  });

  afterEach(async () => {
    if (activeTree) {
      await act(async () => { activeTree!.unmount(); });
      activeTree = null;
    }
    capturedOnChangeText = null;
    jest.clearAllMocks();
    delete (global as unknown as { window?: unknown }).window;
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    (Platform as { OS: string }).OS = originalPlatformOS;
    delete (global as unknown as { XMLHttpRequest?: jest.Mock }).XMLHttpRequest;
  });

  it("attaches a beforeunload handler when loading becomes true on web", async () => {
    const pdfBytes = makePdfBytes();
    const file = makeFile(pdfBytes);

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CatalogPdfUpload adminToken="admin-tok" onSessionExpired={jest.fn()} />,
      );
    });
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!("ACME"); });

    mockXhr.responseText = JSON.stringify({ jobId: "job-1", status: "processing" });

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const beforeunloadCalls = (mockAddEventListener.mock.calls as [string, unknown][]).filter(
      ([event]) => event === "beforeunload",
    );
    expect(beforeunloadCalls.length).toBeGreaterThan(0);
  });

  it("removes the beforeunload handler when loading becomes false after upload completes", async () => {
    const pdfBytes = makePdfBytes();
    const file = makeFile(pdfBytes);

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CatalogPdfUpload adminToken="admin-tok" onSessionExpired={jest.fn()} />,
      );
    });
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const beforeunloadCalls = (mockAddEventListener.mock.calls as [string, unknown][]).filter(
      ([event]) => event === "beforeunload",
    );
    expect(beforeunloadCalls.length).toBeGreaterThan(0);

    const addedHandler = beforeunloadCalls[0]![1];

    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ jobId: "job-1", status: "processing" });
    await act(async () => { mockXhr.fireEvent("load"); });
    await flushPromises();

    const removeCalls = (mockRemoveEventListener.mock.calls as [string, unknown][]).filter(
      ([event, handler]) => event === "beforeunload" && handler === addedHandler,
    );
    expect(removeCalls.length).toBeGreaterThan(0);
  });

  it("does not attach a beforeunload handler on native (Platform.OS = 'ios')", async () => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    (Platform as { OS: string }).OS = "ios";

    const pdfBytes = makePdfBytes();
    const file = makeFile(pdfBytes);

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const mockUploadTask = {
      uploadAsync: jest.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ jobId: "job-2", status: "processing" }) }),
    };
    const { createUploadTask } = require("expo-file-system/legacy") as {
      createUploadTask: jest.Mock;
    };
    createUploadTask.mockReturnValueOnce(mockUploadTask);

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <CatalogPdfUpload adminToken="admin-tok" onSessionExpired={jest.fn()} />,
      );
    });
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    if (capturedOnChangeText) {
      await act(async () => { capturedOnChangeText!("ACME"); });
    }

    const startBtn = findPressable(tree.root, "Start Extraction");
    if (startBtn) {
      await act(async () => { startBtn.props.onPress(); });
      await flushPromises();
    }

    const beforeunloadCalls = (mockAddEventListener.mock.calls as [string, unknown][]).filter(
      ([event]) => event === "beforeunload",
    );
    expect(beforeunloadCalls.length).toBe(0);
  });
});
