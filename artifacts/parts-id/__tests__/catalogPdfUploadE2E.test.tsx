/**
 * @jest-environment node
 *
 * End-to-end upload integration tests for CatalogPdfUpload.
 *
 * Two test groups, both exercising the real rendered component:
 *
 *  1. handlePickFile — component integration
 *     Renders CatalogPdfUpload, presses the "Choose PDF File" button, and
 *     verifies that DocumentPicker.getDocumentAsync is called, and that
 *     readPdfAsBytes receives (asset.uri, asset.file) when the picker returns
 *     an asset with a `file` property (web path).
 *
 *  2. Full happy path — picker → read → first chunk upload attempt
 *     Drives the complete pipeline through the real component: pick file →
 *     readPdfAsBytes resolves → set vendor → "Start Extraction" → verifies
 *     that FileSystem.writeAsStringAsync and FileSystem.createUploadTask are
 *     called with the correct arguments.
 */

// @ts-ignore — required for act() to work correctly in the node environment
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ────────────────────────────────────────────────────────────────

const mockRouterPush = jest.fn();
const mockNavigationAddListener = jest.fn(() => jest.fn());
const mockNavigationDispatch = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
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

const mockWriteAsStringAsync = jest.fn<Promise<void>, [string, string, object?]>().mockResolvedValue(undefined);
const mockDeleteAsync = jest.fn<Promise<void>, [string, object?]>().mockResolvedValue(undefined);
const mockCreateUploadTask = jest.fn();

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///mock-cache/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
  FileSystemSessionType: { BACKGROUND: "BACKGROUND" },
  writeAsStringAsync: (...args: unknown[]) =>
    mockWriteAsStringAsync(...(args as [string, string, object?])),
  deleteAsync: (...args: unknown[]) =>
    mockDeleteAsync(...(args as [string, object?])),
  createUploadTask: (...args: unknown[]) => mockCreateUploadTask(...args),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 512 }),
  readAsStringAsync: jest.fn().mockResolvedValue(""),
}));

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    background: "#fff", foreground: "#000", card: "#fff", border: "#ccc",
    primary: "#3b82f6", primaryForeground: "#fff", muted: "#f1f5f9",
    mutedForeground: "#64748b", destructive: "#ef4444", success: "#22c55e",
    warning: "#f59e0b", accent: "#f1f5f9", accentForeground: "#000",
  }),
}));

// ── @/utils/readPdfAsBase64 ────────────────────────────────────────────────────
// Mocked for the component-level tests (Groups 1 & 2) so we can assert what
// arguments the component passes without needing a real FileReader.
// Group 3 imports directly from the real module.

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

const mockSplitPdfIntoChunks = jest.fn();

jest.mock("@/utils/splitPdfIntoChunks", () => ({
  splitPdfIntoChunks: (...args: unknown[]) => mockSplitPdfIntoChunks(...args),
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
// Captures onChangeText so tests can programmatically update the vendor field.

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

// ── PDF fixture helpers ────────────────────────────────────────────────────────

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function makePdfBytes(extra: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(PDF_MAGIC.length + extra.length);
  out.set(PDF_MAGIC, 0);
  out.set(extra, PDF_MAGIC.length);
  return out;
}

/** Wraps bytes in a real File so `file instanceof File` passes in source code. */
function makeFile(bytes: Uint8Array, name = "catalog.pdf"): File {
  return new File([bytes.buffer as ArrayBuffer], name, { type: "application/pdf" });
}

// ── Render & interaction helpers ──────────────────────────────────────────────

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

async function renderUploadCard(
  adminToken = "admin-tok",
  onSessionExpired = jest.fn(),
): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <CatalogPdfUpload adminToken={adminToken} onSessionExpired={onSessionExpired} />,
    );
  });
  return tree;
}

// ── Per-test teardown ─────────────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }
  capturedOnChangeText = null;
  jest.clearAllMocks();
  mockWriteAsStringAsync.mockResolvedValue(undefined);
  mockDeleteAsync.mockResolvedValue(undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 1 — handlePickFile: component integration
//
// Renders CatalogPdfUpload, presses "Choose PDF File", and verifies that the
// component correctly extracts asset.file from the DocumentPicker result and
// passes it as the second argument to readPdfAsBytes.
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — handlePickFile calls readPdfAsBytes with asset.file", () => {
  it("calls DocumentPicker.getDocumentAsync when 'Choose PDF File' is pressed", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true });

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    expect(pickBtn).not.toBeNull();

    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(mockGetDocumentAsync).toHaveBeenCalledTimes(1);
    expect(mockGetDocumentAsync).toHaveBeenCalledWith({
      type: "application/pdf",
      copyToCacheDirectory: true,
    });
  });

  it("calls readPdfAsBytes with both (uri, file) when the asset has a file property", async () => {
    const pdfBytes = makePdfBytes();
    const file = makeFile(pdfBytes);
    const uri = "blob:http://localhost/catalog.pdf";

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri, name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(mockReadPdfAsBytes).toHaveBeenCalledTimes(1);
    expect(mockReadPdfAsBytes).toHaveBeenCalledWith(uri, file);
  });

  it("passes the exact same File reference from the picker to readPdfAsBytes", async () => {
    const pdfBytes = makePdfBytes();
    const pickerFile = makeFile(pdfBytes, "manufacturer-parts.pdf");
    const uri = "blob:http://localhost/mfr.pdf";

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri, name: "manufacturer-parts.pdf", file: pickerFile }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    // The File reference forwarded must be the exact same object the picker returned.
    const receivedFile = mockReadPdfAsBytes.mock.calls[0]?.[1];
    expect(receivedFile).toBe(pickerFile);
  });

  it("calls readPdfAsBytes with undefined as the second arg when the asset has no file property", async () => {
    const pdfBytes = makePdfBytes();
    const uri = "blob:http://localhost/native.pdf";

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri, name: "native.pdf" /* no file property */ }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(mockReadPdfAsBytes).toHaveBeenCalledWith(uri, undefined);
  });

  it("does NOT call readPdfAsBytes when the picker is cancelled", async () => {
    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true });

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(mockReadPdfAsBytes).not.toHaveBeenCalled();
  });

  it("shows the filename label after a successful pick", async () => {
    const pdfBytes = makePdfBytes();

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/acme.pdf", name: "acme.pdf", file: makeFile(pdfBytes) }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const tree = await renderUploadCard();
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).toContain("PDF:");
    expect(allText).toContain("acme.pdf");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 2 — Full happy path: picker → read → first chunk upload attempt
//
// Drives the complete pipeline through the real component:
//   1. Press "Choose PDF File" → picker returns asset with File
//   2. readPdfAsBytes resolves → component sets pdfBytes in state
//   3. Vendor is set via captured KeyboardDoneInput.onChangeText
//   4. "Start Extraction" is pressed
//   5. FileSystem.writeAsStringAsync is called (temp file written)
//   6. FileSystem.createUploadTask is called (upload kicked off)
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — full happy path: picker → read → first chunk upload attempt", () => {
  /** Set up a mock upload task that never resolves (so tests can assert without waiting). */
  function installPendingUploadTask(): jest.Mock {
    const uploadAsync = jest.fn(() => new Promise<never>(() => {})); // hangs forever
    mockCreateUploadTask.mockReturnValue({ uploadAsync, cancelAsync: jest.fn() });
    return uploadAsync;
  }

  async function pickFileAndSetVendor(
    tree: renderer.ReactTestRenderer,
    pdfBytes: Uint8Array,
    vendor = "ACME",
  ): Promise<void> {
    const file = makeFile(pdfBytes);
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    // Set vendor via the captured onChangeText from KeyboardDoneInput
    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!(vendor); });
  }

  it("calls FileSystem.writeAsStringAsync when 'Start Extraction' is pressed after a successful pick", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();

    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(mockWriteAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it("calls FileSystem.createUploadTask after writeAsStringAsync for the first chunk", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);

    // writeAsStringAsync must have been called before createUploadTask
    const writeOrder = mockWriteAsStringAsync.mock.invocationCallOrder[0]!;
    const createOrder = mockCreateUploadTask.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(createOrder);
  });

  it("createUploadTask is called with the catalog-pdf API endpoint", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const firstCallArgs = mockCreateUploadTask.mock.calls[0] as unknown[];
    expect(typeof firstCallArgs[0]).toBe("string");
    expect((firstCallArgs[0] as string)).toContain("/admin/catalog-pdf");
  });

  it("createUploadTask receives the Authorization header with the admin token", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard("my-admin-token-xyz");
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const firstCallArgs = mockCreateUploadTask.mock.calls[0] as unknown[];
    const options = firstCallArgs[2] as { headers: Record<string, string> };
    expect(options.headers.Authorization).toBe("Bearer my-admin-token-xyz");
  });

  it("createUploadTask is called with BACKGROUND session type", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const firstCallArgs = mockCreateUploadTask.mock.calls[0] as unknown[];
    const options = firstCallArgs[2] as { sessionType: string };
    expect(options.sessionType).toBe("BACKGROUND");
  });

  it("JSON body written to the temp file includes pdfBase64, vendor, and filename", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, makePdfBytes(), "EATON");

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(mockWriteAsStringAsync).toHaveBeenCalled();
    const bodyString = mockWriteAsStringAsync.mock.calls[0]?.[1] as string;
    const body = JSON.parse(bodyString) as Record<string, unknown>;

    expect(typeof body.pdfBase64).toBe("string");
    expect((body.pdfBase64 as string).length).toBeGreaterThan(0);
    expect(body.vendor).toBe("EATON");
    expect(body.filename).toBe("catalog.pdf");
  });

  it("pdfBase64 in the temp file body round-trips back to the original PDF bytes", async () => {
    const { Buffer: NodeBuffer } = require("buffer") as { Buffer: typeof Buffer };
    installPendingUploadTask();

    const originalBytes = makePdfBytes(new Uint8Array([0xAB, 0xCD, 0xEF]));

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendor(tree, originalBytes);

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const bodyString = mockWriteAsStringAsync.mock.calls[0]?.[1] as string;
    const body = JSON.parse(bodyString) as { pdfBase64: string };
    const decoded = new Uint8Array(NodeBuffer.from(body.pdfBase64, "base64"));

    expect(Array.from(decoded)).toEqual(Array.from(originalBytes));
  });

  it("does not call writeAsStringAsync or createUploadTask if no file has been picked", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    // Set vendor without picking a file
    await act(async () => { capturedOnChangeText?.("ACME"); });

    // Start Extraction button is disabled when pdfBytes is null
    const startBtn = findPressable(tree.root, "Start Extraction");
    // Even if present, pressing it while disabled should be a no-op
    if (startBtn) {
      await act(async () => { startBtn.props.onPress?.(); });
    }
    await flushPromises();

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });
});

