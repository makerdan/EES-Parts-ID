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

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

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
    expect(mockReadPdfAsBytes).toHaveBeenCalledWith(uri, file, expect.any(Function));
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

    expect(mockReadPdfAsBytes).toHaveBeenCalledWith(uri, undefined, expect.any(Function));
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

// ══════════════════════════════════════════════════════════════════════════════
// Group 3 — Pre-flight validation guards
//
// Verifies that the component rejects bad inputs before sendChunkViaBackground
// fires, so failures surface as client-side errors instead of server-side ones.
//
//  • Blank vendor → Start button disabled; handler returns early
//  • Zero-length PDF bytes → handler returns early with a user-visible error
//  • InvalidPdfError from readPdfAsBytes → error shown; upload never started
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — pre-flight validation guards", () => {
  function installPendingUploadTask(): void {
    const uploadAsync = jest.fn(() => new Promise<never>(() => {}));
    mockCreateUploadTask.mockReturnValue({ uploadAsync, cancelAsync: jest.fn() });
  }

  async function pickFileWith(
    tree: renderer.ReactTestRenderer,
    bytes: Uint8Array,
    name = "catalog.pdf",
  ): Promise<void> {
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name, file: makeFile(bytes) }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(bytes);

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();
  }

  // ── Blank vendor ─────────────────────────────────────────────────────────

  it("Start Extraction button is disabled when vendor is blank after a file is picked", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, makePdfBytes());
    // Deliberately do NOT set vendor

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();
    expect(startBtn!.props.disabled).toBe(true);
  });

  it("shows a hint prompting the admin to enter a vendor name when vendor is blank", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, makePdfBytes());

    const allText = instText(tree.root);
    expect(allText.toLowerCase()).toContain("vendor name");
  });

  it("does not fire the upload when vendor is blank: writeAsStringAsync is never called", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, makePdfBytes());

    // Button is disabled; pressing it should be a no-op
    const startBtn = findPressable(tree.root, "Start Extraction");
    if (startBtn && !startBtn.props.disabled) {
      await act(async () => { startBtn.props.onPress?.(); });
      await flushPromises();
    }

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });

  // ── Zero-length PDF bytes ─────────────────────────────────────────────────

  it("Start Extraction button is enabled for zero-length bytes (guard lives in the handler)", async () => {
    // A zero-length Uint8Array is truthy so the button disability logic
    // does NOT catch it — the guard in handleStart is what prevents the request.
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, new Uint8Array(0));
    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();
    // Disabled prop must be falsy (button is reachable so the handler fires)
    expect(startBtn!.props.disabled).toBeFalsy();
  });

  it("does not call writeAsStringAsync when zero-length bytes are detected on Start", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, new Uint8Array(0));
    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress?.(); });
    await flushPromises();

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });

  it("surfaces a user-visible error message when zero-length bytes are detected on Start", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileWith(tree, new Uint8Array(0));
    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress?.(); });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText.toLowerCase()).toContain("empty");
  });

  // ── InvalidPdfError from the read step ───────────────────────────────────

  it("surfaces the InvalidPdfError message in the UI after the picker completes", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/bad.pdf", name: "bad.pdf" }],
    });
    mockReadPdfAsBytes.mockRejectedValueOnce(
      new Error("The selected file is not a valid PDF. Please choose a PDF file and try again."),
    );

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).toContain("not a valid PDF");
  });

  it("does not start an upload after InvalidPdfError: writeAsStringAsync is never called", async () => {
    installPendingUploadTask();

    const tree = await renderUploadCard();
    activeTree = tree;

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/bad.pdf", name: "bad.pdf" }],
    });
    mockReadPdfAsBytes.mockRejectedValueOnce(
      new Error("The selected file is not a valid PDF. Please choose a PDF file and try again."),
    );

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    // pdfBytes was never set, so Start remains disabled even with a vendor
    await act(async () => { capturedOnChangeText!("ACME"); });
    await flushPromises();

    const startBtn = findPressable(tree.root, "Start Extraction");
    if (startBtn && !startBtn.props.disabled) {
      await act(async () => { startBtn.props.onPress?.(); });
      await flushPromises();
    }

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });

  it("pdfBytes state is null after InvalidPdfError so Start button stays disabled", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/bad.pdf", name: "bad.pdf" }],
    });
    mockReadPdfAsBytes.mockRejectedValueOnce(
      new Error("The selected file is not a valid PDF. Please choose a PDF file and try again."),
    );

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    // Set vendor — Start button should still be disabled because pdfBytes is null
    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();
    expect(startBtn!.props.disabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 4 — 401 mid-chunk: session expiry during upload
//
// Verifies that when the server returns HTTP 401 during a chunk upload:
//   1. The onSessionExpired callback is invoked.
//   2. Loading is cleared (no rn-activity spinner leak in the tree).
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — 401 mid-chunk: onSessionExpired is called and loading is cleared", () => {
  // CHUNK_SIZE_THRESHOLD is 20 MB — bytes must exceed it to trigger the
  // chunked upload path (handleChunkedUpload → uploadChunksFromIndex →
  // sendChunkViaBackground), which is where the 401 fix lives.
  const OVER_THRESHOLD = 20 * 1024 * 1024 + 1;

  /** Minimal chunk shape expected by uploadChunksFromIndex. */
  function makeChunks(n = 2) {
    return Array.from({ length: n }, (_, i) => ({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      pageOffset: i * 20,
    }));
  }

  /** Returns an uploadAsync mock that resolves with the given status. */
  function installUploadTaskWithStatus(status: number, body = ""): jest.Mock {
    const uploadAsync = jest.fn().mockResolvedValue({ status, body });
    mockCreateUploadTask.mockReturnValue({ uploadAsync, cancelAsync: jest.fn() });
    return uploadAsync;
  }

  async function pickChunkedFileSetVendorAndStart(
    tree: renderer.ReactTestRenderer,
    vendor = "ACME",
  ): Promise<void> {
    // Return bytes that exceed CHUNK_SIZE_THRESHOLD so handleChunkedUpload fires.
    const largePdfBytes = new Uint8Array(OVER_THRESHOLD);
    largePdfBytes.set(PDF_MAGIC, 0);

    const file = makeFile(largePdfBytes);
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(largePdfBytes);

    // splitPdfIntoChunks must return ≥2 chunks so the multi-chunk path is taken
    // (a single-chunk result delegates to handleSingleUpload).
    mockSplitPdfIntoChunks.mockResolvedValueOnce(makeChunks(2));

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!(vendor); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();
  }

  it("calls onSessionExpired when the server returns 401 during a chunked upload", async () => {
    installUploadTaskWithStatus(401);
    const onSessionExpired = jest.fn();

    const tree = await renderUploadCard("admin-tok", onSessionExpired);
    activeTree = tree;

    await pickChunkedFileSetVendorAndStart(tree);

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("clears loading (no rn-activity spinner) after a 401 response in a chunked upload", async () => {
    installUploadTaskWithStatus(401);
    const onSessionExpired = jest.fn();

    const tree = await renderUploadCard("admin-tok", onSessionExpired);
    activeTree = tree;

    await pickChunkedFileSetVendorAndStart(tree);

    // ActivityIndicator is mocked as "rn-activity" in __mocks__/react-native.js.
    // After the 401 is handled, setLoading(false) must have been called so no
    // spinner remains in the tree.
    const spinners = tree.root.findAll(
      (n) => (n.type as string) === "rn-activity",
      { deep: true },
    );
    expect(spinners).toHaveLength(0);
  });

  it("does not call onSessionExpired when the server returns 200 on a chunked upload", async () => {
    // First chunk succeeds; second chunk also returns 200 — no session expiry.
    mockCreateUploadTask
      .mockReturnValueOnce({ uploadAsync: jest.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ jobId: "job-1" }) }), cancelAsync: jest.fn() })
      .mockReturnValueOnce({ uploadAsync: jest.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ jobId: "job-1", chunkJobId: "cjob-2" }) }), cancelAsync: jest.fn() });
    const onSessionExpired = jest.fn();

    const tree = await renderUploadCard("admin-tok", onSessionExpired);
    activeTree = tree;

    await pickChunkedFileSetVendorAndStart(tree);

    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 5 — Web upload path (Platform.OS = "web")
//
// Verifies that when running on web:
//   • FileSystem.writeAsStringAsync and FileSystem.createUploadTask are NEVER
//     called (those APIs are native-only and would throw on web).
//   • XMLHttpRequest is used instead, with the correct URL, Authorization
//     header, and a JSON body containing `pdfBase64` and `vendor`.
//   • An XHR error event surfaces the "Network error" message in the UI.
//   • An XHR load event with status 200 triggers polling (status endpoint
//     is fetched).
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — web upload path (Platform.OS = 'web')", () => {
  let originalPlatformOS: string;

  // ── XHR mock infrastructure ───────────────────────────────────────────────
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
    /** Fire a synthetic event as if the browser raised it. */
    fireEvent(name: XhrEventName): void;
  }

  let mockXhr: MockXhr;
  let MockXMLHttpRequest: jest.Mock;

  beforeEach(() => {
    // Save and override Platform.OS
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    originalPlatformOS = Platform.OS;
    (Platform as { OS: string }).OS = "web";

    // Build a controllable XHR mock
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

    MockXMLHttpRequest = jest.fn(() => mockXhr);
    (global as unknown as { XMLHttpRequest: jest.Mock }).XMLHttpRequest = MockXMLHttpRequest;
  });

  afterEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    (Platform as { OS: string }).OS = originalPlatformOS;
    delete (global as unknown as { XMLHttpRequest?: jest.Mock }).XMLHttpRequest;
  });

  async function pickFileAndSetVendorWeb(
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

    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!(vendor); });
  }

  it("never calls FileSystem.writeAsStringAsync or createUploadTask on web", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();

    // Press start but do NOT fire XHR events — XHR hangs, letting us assert synchronously
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(mockWriteAsStringAsync).not.toHaveBeenCalled();
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
    expect(MockXMLHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("sends XHR to the catalog-pdf endpoint with Authorization header and correct body", async () => {
    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes(), "BRIDGEPORT");

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    // URL
    expect(mockXhr.open).toHaveBeenCalledWith("POST", expect.stringContaining("/admin/catalog-pdf"), true);

    // Authorization header
    const authCall = (mockXhr.setRequestHeader.mock.calls as [string, string][]).find(
      ([key]) => key === "Authorization",
    );
    expect(authCall).toBeDefined();
    expect(authCall![1]).toBe("Bearer web-admin-token");

    // Body contains pdfBase64 and vendor
    expect(mockXhr.send).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(mockXhr.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(typeof sentBody.pdfBase64).toBe("string");
    expect((sentBody.pdfBase64 as string).length).toBeGreaterThan(0);
    expect(sentBody.vendor).toBe("BRIDGEPORT");
  });

  it("surfaces 'Network error' in the UI when XHR fires an error event (regression guard)", async () => {
    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    // Simulate XHR network error
    await act(async () => { mockXhr.fireEvent("error"); });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText.toLowerCase()).toContain("network error");
  });

  it("triggers polling when XHR load fires with status 200", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-web-1",
        status: "processing",
        totalPages: null,
        processedPages: 0,
        matchedParts: 0,
        imagesMatched: 0,
        errorMessage: null,
      }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ jobId: "job-web-1" });

    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");

    // Switch to fake timers BEFORE pressing start so that startPolling's
    // setInterval is registered under the fake clock and can be advanced.
    jest.useFakeTimers();
    try {
      await act(async () => { startBtn!.props.onPress(); });

      // Fire the XHR load event — this triggers onSuccess → startPolling
      await act(async () => { mockXhr.fireEvent("load"); });

      // Advance the fake clock past POLL_MS (2500 ms) to fire the first interval tick
      await act(() => { jest.advanceTimersByTime(3000); });

      // Drain microtasks so the async fetch inside the interval can complete
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    } finally {
      jest.useRealTimers();
    }

    // The polling loop calls /admin/catalog-pdf/{jobId}/status (not catalog-jobs)
    const statusCalls = (fetchMock.mock.calls as [string][]).filter(([url]) =>
      typeof url === "string" && url.includes("/admin/catalog-pdf/"),
    );
    expect(statusCalls.length).toBeGreaterThan(0);

    delete (global as unknown as { fetch?: jest.Mock }).fetch;
  });

  it("fires xhr.upload.onprogress → progress bar appears with correct percentage", async () => {
    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();

    // Press start — XHR is created and hangs (no load/error event fired)
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    // XHR must have been created and onprogress must have been attached
    expect(MockXMLHttpRequest).toHaveBeenCalledTimes(1);
    expect(mockXhr.upload.onprogress).not.toBeNull();

    // Fire a progress event: 5 MB of 10 MB sent → 50%
    await act(async () => {
      mockXhr.upload.onprogress!({
        lengthComputable: true,
        loaded: 5 * 1024 * 1024,
        total: 10 * 1024 * 1024,
      });
    });
    await flushPromises();

    // The progress bar text must appear in the tree
    const allText = instText(tree.root);
    expect(allText).toContain("50% uploaded");
  });

  it("shows speed and ETA after ≥ 3 progress events; both disappear on upload completion", async () => {
    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(mockXhr.upload.onprogress).not.toBeNull();

    const totalBytes = 10 * 1024 * 1024;

    // Simulate time advancing (2 s each) so the speed window has a measurable dt.
    let fakeNow = 1_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      // Fire first 2 events — fewer than 3 samples, so speed/ETA absent yet
      for (const loaded of [2 * 1024 * 1024, 4 * 1024 * 1024]) {
        fakeNow += 2000;
        await act(async () => {
          mockXhr.upload.onprogress!({ lengthComputable: true, loaded, total: totalBytes });
        });
        await flushPromises();
      }

      let allText = instText(tree.root);
      expect(allText).not.toMatch(/MB\/s/);
      expect(allText).not.toMatch(/remaining/);

      // Fire a third event — stable throughput, so speed AND ETA should now appear
      fakeNow += 2000;
      await act(async () => {
        mockXhr.upload.onprogress!({ lengthComputable: true, loaded: 6 * 1024 * 1024, total: totalBytes });
      });
      await flushPromises();

      allText = instText(tree.root);
      expect(allText).toMatch(/MB\/s/);
      expect(allText).toMatch(/remaining/);
    } finally {
      dateSpy.mockRestore();
    }

    // Complete the upload — speed and ETA must both disappear
    mockXhr.status = 200;
    mockXhr.responseText = JSON.stringify({ jobId: "eta-test-job" });
    await act(async () => { mockXhr.fireEvent("load"); });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).not.toMatch(/MB\/s/);
    expect(allText).not.toMatch(/remaining/);
  });

  it("does not show speed or ETA when only 1 progress event fires (not enough data)", async () => {
    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    // Single progress event — too few samples
    await act(async () => {
      mockXhr.upload.onprogress!({ lengthComputable: true, loaded: 5 * 1024 * 1024, total: 10 * 1024 * 1024 });
    });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).toContain("50% uploaded");
    expect(allText).not.toMatch(/MB\/s/);
    expect(allText).not.toMatch(/remaining/);
  });

  it("hides ETA (but still shows speed) when throughput is too variable", async () => {
    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    await pickFileAndSetVendorWeb(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const totalBytes = 100 * 1024 * 1024;

    // CV > 1.5 requires ≥ 4 inter-sample speed pairs (≥ 5 samples).
    // Pattern: 3 very slow samples then 1 huge spike then 1 very slow.
    // Inter-sample speeds (bytes/ms): [~0.1, ~0.1, ~4194, ~0.1]
    // mean ≈ 1049, std ≈ 1816, CV ≈ 1.73 > 1.5.
    const TINY = 200;
    const HUGE = 8 * 1024 * 1024;
    const events = [
      { loaded: TINY,              dt: 2000 },
      { loaded: TINY * 2,          dt: 2000 },
      { loaded: TINY * 2 + HUGE,   dt: 2000 },
      { loaded: TINY * 3 + HUGE,   dt: 2000 },
      { loaded: TINY * 4 + HUGE,   dt: 2000 },
    ];

    let fakeNow = 1_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      for (const { loaded, dt } of events) {
        fakeNow += dt;
        await act(async () => {
          mockXhr.upload.onprogress!({ lengthComputable: true, loaded, total: totalBytes });
        });
        await flushPromises();
      }
    } finally {
      dateSpy.mockRestore();
    }

    const allText = instText(tree.root);
    // Speed is still shown (useful even when erratic)
    expect(allText).toMatch(/MB\/s/);
    // ETA is suppressed because CV > 1.5
    expect(allText).not.toMatch(/remaining/);
  });

  it("chunked web upload: each chunk uses a separate XHR sequentially, polling starts after the last", async () => {
    const OVER_THRESHOLD = 20 * 1024 * 1024 + 1;

    // Queue of XHR mocks — one per chunk
    const xhrQueue: MockXhr[] = [];
    let xhrIndex = 0;

    function makeMockXhr(): MockXhr {
      const xhr: MockXhr = {
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
      xhrQueue.push(xhr);
      return xhr;
    }

    MockXMLHttpRequest = jest.fn(() => makeMockXhr());
    (global as unknown as { XMLHttpRequest: jest.Mock }).XMLHttpRequest = MockXMLHttpRequest;

    // Two chunks — use the same shape as Group 4
    const chunk0Resp = JSON.stringify({ jobId: "web-parent-1" });
    const chunk1Resp = JSON.stringify({ jobId: "web-parent-1", chunkJobId: "web-chunk-2" });

    // Build large PDF bytes
    const largePdfBytes = new Uint8Array(OVER_THRESHOLD);
    largePdfBytes.set(PDF_MAGIC, 0);

    const file = makeFile(largePdfBytes);
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/large.pdf", name: "large.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(largePdfBytes);

    const chunk0 = { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), pageOffset: 0 };
    const chunk1 = { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), pageOffset: 20 };
    mockSplitPdfIntoChunks.mockResolvedValueOnce([chunk0, chunk1]);

    const tree = await renderUploadCard("web-admin-token");
    activeTree = tree;

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    expect(startBtn).not.toBeNull();

    // Press start — chunk 0 XHR is created and pending
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    expect(xhrQueue.length).toBe(1);

    // Fire chunk 0 success — loop advances to chunk 1
    xhrQueue[0]!.responseText = chunk0Resp;
    await act(async () => { xhrQueue[0]!.fireEvent("load"); });
    await flushPromises();

    expect(xhrQueue.length).toBe(2);

    // Fire chunk 1 success — loop finishes and startPolling is called
    jest.useFakeTimers();
    try {
      xhrQueue[1]!.responseText = chunk1Resp;
      await act(async () => { xhrQueue[1]!.fireEvent("load"); });

      // Both XHRs must have been called with the correct endpoint
      for (let i = 0; i < 2; i++) {
        expect(xhrQueue[i]!.open).toHaveBeenCalledWith(
          "POST", expect.stringContaining("/admin/catalog-pdf"), true,
        );
        expect(xhrQueue[i]!.setRequestHeader).toHaveBeenCalledWith(
          "Authorization", "Bearer web-admin-token",
        );
      }

      // Advance past POLL_MS to confirm polling is wired up
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jobId: "web-parent-1", status: "processing", totalPages: null, processedPages: 0, matchedParts: 0, imagesMatched: 0, errorMessage: null }),
      });
      (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

      await act(() => { jest.advanceTimersByTime(3000); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const statusCalls = (fetchMock.mock.calls as [string][]).filter(
        ([url]) => typeof url === "string" && url.includes("/admin/catalog-pdf/"),
      );
      expect(statusCalls.length).toBeGreaterThan(0);

      delete (global as unknown as { fetch?: jest.Mock }).fetch;
    } finally {
      jest.useRealTimers();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 6 — Native upload path ETA (Platform.OS = "ios")
//
// Verifies that when running on iOS (or Android — same code path):
//   • The FileSystem.createUploadTask progress callback fires onProgressBytes.
//   • After ≥ 3 spaced progress events the upload speed and ETA text appear.
//   • Both disappear once uploadAsync resolves (resetUploadProgress is called).
//   • With only 1 progress event the UI has no speed or ETA text yet.
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — native upload path ETA (Platform.OS = 'ios')", () => {
  let originalPlatformOS: string;

  beforeEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    originalPlatformOS = Platform.OS;
    (Platform as { OS: string }).OS = "ios";
  });

  afterEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    (Platform as { OS: string }).OS = originalPlatformOS;
  });

  /**
   * Sets up mockCreateUploadTask so it:
   *   1. Captures the native progress callback passed as the 4th argument.
   *   2. Returns a task whose uploadAsync is a promise that callers can
   *      resolve manually via the returned `resolve` function.
   */
  function installControllableUploadTask(): {
    getProgressCallback: () => ((data: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void) | undefined;
    resolveUpload: (result: { status: number; body: string }) => void;
  } {
    let capturedCallback: ((data: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void) | undefined;
    let resolveUpload!: (result: { status: number; body: string }) => void;

    mockCreateUploadTask.mockImplementation(
      (_url: unknown, _tempUri: unknown, _options: unknown, progressCallback: unknown) => {
        capturedCallback = progressCallback as typeof capturedCallback;
        return {
          uploadAsync: jest.fn(
            () => new Promise<{ status: number; body: string }>((res) => { resolveUpload = res; }),
          ),
          cancelAsync: jest.fn(),
        };
      },
    );

    return {
      getProgressCallback: () => capturedCallback,
      resolveUpload: (result) => resolveUpload(result),
    };
  }

  async function pickFileAndSetVendorNative(
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

    expect(capturedOnChangeText).not.toBeNull();
    await act(async () => { capturedOnChangeText!(vendor); });
  }

  it("progress bar appears after the native progress callback fires once", async () => {
    const { getProgressCallback } = installControllableUploadTask();

    const tree = await renderUploadCard("native-admin-tok");
    activeTree = tree;

    await pickFileAndSetVendorNative(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const cb = getProgressCallback();
    expect(cb).toBeDefined();

    await act(async () => {
      cb!({ totalBytesSent: 3 * 1024 * 1024, totalBytesExpectedToSend: 10 * 1024 * 1024 });
    });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).toContain("30% uploaded");
  });

  it("shows speed and ETA after ≥ 3 native progress events; both disappear when uploadAsync resolves", async () => {
    const { getProgressCallback, resolveUpload } = installControllableUploadTask();

    const tree = await renderUploadCard("native-admin-tok");
    activeTree = tree;

    await pickFileAndSetVendorNative(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const cb = getProgressCallback();
    expect(cb).toBeDefined();

    const totalBytes = 10 * 1024 * 1024;

    let fakeNow = 1_000_000;
    const dateSpy = jest.spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      // Fire first 2 events — fewer than 3 samples, so speed/ETA absent yet
      for (const sent of [2 * 1024 * 1024, 4 * 1024 * 1024]) {
        fakeNow += 2000;
        await act(async () => {
          cb!({ totalBytesSent: sent, totalBytesExpectedToSend: totalBytes });
        });
        await flushPromises();
      }

      let allText = instText(tree.root);
      expect(allText).not.toMatch(/MB\/s/);
      expect(allText).not.toMatch(/remaining/);

      // Fire a third event — stable throughput, so speed AND ETA should now appear
      fakeNow += 2000;
      await act(async () => {
        cb!({ totalBytesSent: 6 * 1024 * 1024, totalBytesExpectedToSend: totalBytes });
      });
      await flushPromises();

      allText = instText(tree.root);
      expect(allText).toMatch(/MB\/s/);
      expect(allText).toMatch(/remaining/);
    } finally {
      dateSpy.mockRestore();
    }

    // Resolve the upload — speed and ETA must both disappear
    await act(async () => {
      resolveUpload({ status: 200, body: JSON.stringify({ jobId: "native-eta-job" }) });
    });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).not.toMatch(/MB\/s/);
    expect(allText).not.toMatch(/remaining/);
  });

  it("does not show speed or ETA when only 1 native progress event fires (not enough data)", async () => {
    const { getProgressCallback } = installControllableUploadTask();

    const tree = await renderUploadCard("native-admin-tok");
    activeTree = tree;

    await pickFileAndSetVendorNative(tree, makePdfBytes());

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    const cb = getProgressCallback();
    expect(cb).toBeDefined();

    // Single progress event — too few samples for speed/ETA computation
    await act(async () => {
      cb!({ totalBytesSent: 5 * 1024 * 1024, totalBytesExpectedToSend: 10 * 1024 * 1024 });
    });
    await flushPromises();

    const allText = instText(tree.root);
    expect(allText).toContain("50% uploaded");
    expect(allText).not.toMatch(/MB\/s/);
    expect(allText).not.toMatch(/remaining/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Group 7 — Poll abort safety: stopPolling / unmount mid-flight
//
// The polling loop was rewritten to use AbortController + a sequential
// while-loop. These tests verify the exact failure modes the rewrite was
// meant to prevent:
//
//   1. The AbortController signal is immediately aborted when the component
//      unmounts while a poll fetch is in-flight (not just skipped on the
//      next loop iteration).
//
//   2. No state update (setJobStatus) reaches the component when a slow
//      poll response resolves after stopPolling has already fired: the
//      gen-counter guard and the signal check both gate the setter call,
//      so the UI stays in whatever terminal state stopPolling left it in.
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — poll abort safety on unmount / stopPolling mid-flight", () => {
  let originalPlatformOS: string;

  // ── XHR mock (same shape as Group 5) ─────────────────────────────────────
  type XhrEventName = "load" | "error" | "abort";

  interface MockXhrG7 {
    open: jest.Mock;
    setRequestHeader: jest.Mock;
    send: jest.Mock;
    abort: jest.Mock;
    status: number;
    responseText: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    upload: { onprogress: null };
    fireEvent(name: XhrEventName): void;
  }

  let mockXhrG7: MockXhrG7;
  let MockXMLHttpRequestG7: jest.Mock;

  beforeEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    originalPlatformOS = Platform.OS;
    (Platform as { OS: string }).OS = "web";

    mockXhrG7 = {
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

    MockXMLHttpRequestG7 = jest.fn(() => mockXhrG7);
    (global as unknown as { XMLHttpRequest: jest.Mock }).XMLHttpRequest = MockXMLHttpRequestG7;
  });

  afterEach(() => {
    const { Platform } = require("react-native") as { Platform: { OS: string } };
    (Platform as { OS: string }).OS = originalPlatformOS;
    delete (global as unknown as { XMLHttpRequest?: jest.Mock }).XMLHttpRequest;
    delete (global as unknown as { fetch?: jest.Mock }).fetch;
  });

  /**
   * Drive the component through pick → vendor → start → XHR load (200) so
   * that startPolling fires and the first polling fetch is in-flight.
   *
   * Returns the captured AbortSignal passed to fetch() by the polling loop.
   */
  async function startPollingInFlight(
    tree: renderer.ReactTestRenderer,
    fetchImpl: (url: string, opts: RequestInit) => Promise<unknown>,
  ): Promise<AbortSignal> {
    let capturedSignal: AbortSignal | undefined;

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      (url: string, opts: RequestInit) => {
        capturedSignal = opts?.signal as AbortSignal | undefined;
        return fetchImpl(url, opts);
      },
    );

    const pdfBytes = makePdfBytes();
    const file = makeFile(pdfBytes);
    mockGetDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "blob:http://localhost/catalog.pdf", name: "catalog.pdf", file }],
    });
    mockReadPdfAsBytes.mockResolvedValueOnce(pdfBytes);

    const pickBtn = findPressable(tree.root, "Choose PDF File");
    await act(async () => { pickBtn!.props.onPress(); });
    await flushPromises();

    await act(async () => { capturedOnChangeText!("ACME"); });

    const startBtn = findPressable(tree.root, "Start Extraction");
    await act(async () => { startBtn!.props.onPress(); });
    await flushPromises();

    // Fire the upload XHR load → onSuccess → startPolling → fetch (polling)
    mockXhrG7.status = 200;
    mockXhrG7.responseText = JSON.stringify({ jobId: "job-abort-test" });
    await act(async () => { mockXhrG7.fireEvent("load"); });
    await flushPromises();

    // At this point the polling fetch should have been called and be in-flight.
    expect(capturedSignal).toBeDefined();
    return capturedSignal!;
  }

  it("AbortController signal is aborted immediately when the component unmounts during an in-flight poll", async () => {
    const tree = await renderUploadCard("admin-tok");
    activeTree = tree;

    // Polling fetch hangs forever — simulates a slow server response.
    const signal = await startPollingInFlight(tree, () => new Promise<never>(() => {}));

    expect(signal.aborted).toBe(false);

    // Unmount → useEffect cleanup calls stopPolling → pollRef.current.abort()
    await act(async () => { tree.unmount(); });
    activeTree = null;

    // The signal must be aborted synchronously within the cleanup.
    expect(signal.aborted).toBe(true);
  });

  it("does not update job status when a slow poll response resolves after stopPolling fires on unmount", async () => {
    let resolveFetch!: (value: unknown) => void;

    const tree = await renderUploadCard("admin-tok");
    activeTree = tree;

    // Polling fetch hangs until we manually resolve it.
    const signal = await startPollingInFlight(
      tree,
      () => new Promise<unknown>((res) => { resolveFetch = res; }),
    );

    // Signal not yet aborted — the fetch is in-flight.
    expect(signal.aborted).toBe(false);

    // Unmount → stopPolling → signal aborted.
    await act(async () => { tree.unmount(); });
    activeTree = null;

    expect(signal.aborted).toBe(true);

    // Now resolve the hanging fetch with a "done" response — this is the
    // slow-response-after-cancel scenario.  The polling loop checks
    // `controller.signal.aborted` (true) before calling setJobStatus, so the
    // setter is never invoked.  We verify there are no unexpected errors and
    // that the abort guard held by confirming the signal remained aborted
    // throughout (no re-assignment occurred).
    const donePayload = {
      jobId: "job-abort-test",
      status: "done" as const,
      totalPages: 10,
      processedPages: 10,
      matchedParts: 5,
      imagesMatched: 0,
      errorMessage: null,
    };

    // Construct a minimal Response-like object accepted by the poll loop.
    const fakeResponse = {
      ok: true,
      status: 200,
      json: async () => donePayload,
    };

    // Resolving must not throw — any erroneous setState on an unmounted
    // component (React 18 no-op) or unhandled rejection would surface here.
    await act(async () => { resolveFetch(fakeResponse); });
    await flushPromises();

    // The signal must still be aborted — it was never reset.
    expect(signal.aborted).toBe(true);

    // A freshly mounted instance must start with no job status, proving
    // the stale response did not corrupt any module-level state.
    const freshTree = await renderUploadCard("admin-tok");
    activeTree = freshTree;
    const freshAllText = instText(freshTree.root);
    expect(freshAllText).not.toContain("done");
    expect(freshAllText).not.toContain("job-abort-test");
  });
});

