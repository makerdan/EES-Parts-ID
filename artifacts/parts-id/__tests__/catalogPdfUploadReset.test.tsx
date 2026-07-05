/**
 * @jest-environment node
 *
 * Confirms that every reset/cancel exit path in CatalogPdfUpload fully clears
 * both the vendor field and the AI raw log.
 *
 * Three exit paths are exercised:
 *   1. "Start new extraction" — pressed after a job completes (status = "done")
 *   2. "Start new job"        — pressed after a job is cancelled (status = "cancelled")
 *   3. "Try again"            — pressed after a job fails with no stored chunks
 *                               (status = "failed", no failedChunks, hasStoredChunks = false)
 *
 * Each test:
 *   a. Mounts the component and picks a file with vendor "ACME".
 *   b. Runs a single-chunk native upload (Platform.OS = "ios") that resolves
 *      immediately, causing startPolling to fire.
 *   c. Makes the first poll fetch return a terminal job status that also carries
 *      aiRawLog entries → both vendor and aiRawLog are non-empty at this point.
 *   d. Presses the reset button for that exit path.
 *   e. Asserts vendor is empty and the AI raw log count is gone.
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
// Captures both onChangeText and the current value prop so tests can assert
// what the vendor field contains after a reset.

let capturedOnChangeText: ((v: string) => void) | null = null;
let capturedVendorValue: string | null = null;

jest.mock("@/components/KeyboardDoneInput", () => ({
  KeyboardDoneInput: (props: { onChangeText?: (v: string) => void; value?: string; [k: string]: unknown }) => {
    capturedOnChangeText = props.onChangeText ?? null;
    capturedVendorValue = props.value ?? null;
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

// ── Per-test setup / teardown ─────────────────────────────────────────────────

let activeTree: renderer.ReactTestRenderer | null = null;
let originalPlatformOS: string;

beforeEach(() => {
  const { Platform } = require("react-native") as { Platform: { OS: string } };
  originalPlatformOS = Platform.OS;
  (Platform as { OS: string }).OS = "ios";
});

afterEach(async () => {
  if (activeTree) {
    await act(async () => { activeTree!.unmount(); });
    activeTree = null;
  }

  const { Platform } = require("react-native") as { Platform: { OS: string } };
  (Platform as { OS: string }).OS = originalPlatformOS;

  capturedOnChangeText = null;
  capturedVendorValue = null;
  jest.clearAllMocks();
  mockWriteAsStringAsync.mockResolvedValue(undefined);
  mockDeleteAsync.mockResolvedValue(undefined);
  delete (global as unknown as { fetch?: unknown }).fetch;
});

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * AI raw log entries used to pre-populate aiRawLog state via the poll response.
 * Two entries covering different pages so the count shows "· 2" in the tab label.
 */
const AI_LOG_ENTRIES = [
  { page: 1, text: "Part A 1234", chunkJobId: "cjob-1" },
  { page: 2, text: "Part B 5678", chunkJobId: "cjob-1" },
];

/**
 * Installs a native upload task that resolves immediately with a 200 + jobId,
 * triggering startPolling inside the component.
 */
function installImmediateUploadTask(jobId = "test-job-1"): void {
  mockCreateUploadTask.mockReturnValue({
    uploadAsync: jest.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({ jobId }),
    }),
    cancelAsync: jest.fn(),
  });
}

/**
 * Picks a PDF file, sets the vendor to "ACME", and presses "Start Extraction".
 * Relies on Platform.OS = "ios" (set in beforeEach) so the native upload path
 * is taken (FileSystem.createUploadTask → uploadAsync resolves → startPolling).
 */
async function pickFileSetVendorAndStart(
  tree: renderer.ReactTestRenderer,
  vendor = "ACME",
): Promise<void> {
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

  expect(capturedOnChangeText).not.toBeNull();
  await act(async () => { capturedOnChangeText!(vendor); });

  const startBtn = findPressable(tree.root, "Start Extraction");
  expect(startBtn).not.toBeNull();
  await act(async () => { startBtn!.props.onPress(); });
  await flushPromises();
}

// ══════════════════════════════════════════════════════════════════════════════
// Reset state tests — all three exit paths
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogPdfUpload — reset clears vendor and AI log across all exit paths", () => {
  // ── Exit path 1: "Start new extraction" (done) ───────────────────────────

  it('done → "Start new extraction" clears vendor to empty string', async () => {
    installImmediateUploadTask("job-done-1");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-done-1",
        status: "done",
        totalPages: 2,
        processedPages: 2,
        matchedParts: 3,
        imagesMatched: 0,
        errorMessage: null,
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    // Vendor must be non-empty and AI log must have entries before reset
    expect(capturedVendorValue).toBe("ACME");
    const textBefore = instText(tree.root);
    expect(textBefore).toContain("AI Raw · 2");

    // Press "Start new extraction"
    const resetBtn = findPressable(tree.root, "Start new extraction");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedVendorValue).toBe("");
  });

  it('done → "Start new extraction" clears AI raw log (count badge disappears)', async () => {
    installImmediateUploadTask("job-done-2");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-done-2",
        status: "done",
        totalPages: 2,
        processedPages: 2,
        matchedParts: 3,
        imagesMatched: 0,
        errorMessage: null,
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    expect(instText(tree.root)).toContain("AI Raw · 2");

    const resetBtn = findPressable(tree.root, "Start new extraction");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(instText(tree.root)).not.toContain("AI Raw ·");
  });

  // ── Exit path 2: "Start new job" (cancelled) ─────────────────────────────

  it('cancelled → "Start new job" clears vendor to empty string', async () => {
    installImmediateUploadTask("job-cancelled-1");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-cancelled-1",
        status: "cancelled",
        totalPages: 2,
        processedPages: 1,
        matchedParts: 1,
        imagesMatched: 0,
        errorMessage: null,
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    expect(capturedVendorValue).toBe("ACME");
    expect(instText(tree.root)).toContain("AI Raw · 2");

    const resetBtn = findPressable(tree.root, "Start new job");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedVendorValue).toBe("");
  });

  it('cancelled → "Start new job" clears AI raw log (count badge disappears)', async () => {
    installImmediateUploadTask("job-cancelled-2");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-cancelled-2",
        status: "cancelled",
        totalPages: 2,
        processedPages: 1,
        matchedParts: 1,
        imagesMatched: 0,
        errorMessage: null,
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    expect(instText(tree.root)).toContain("AI Raw · 2");

    const resetBtn = findPressable(tree.root, "Start new job");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(instText(tree.root)).not.toContain("AI Raw ·");
  });

  // ── Exit path 3: "Try again" (failed, no stored chunks) ──────────────────

  it('failed (no chunks) → "Try again" clears vendor to empty string', async () => {
    installImmediateUploadTask("job-failed-1");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-failed-1",
        status: "failed",
        totalPages: null,
        processedPages: 0,
        matchedParts: 0,
        imagesMatched: 0,
        errorMessage: "processing_error",
        failedChunks: [],
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    expect(capturedVendorValue).toBe("ACME");
    expect(instText(tree.root)).toContain("AI Raw · 2");

    const resetBtn = findPressable(tree.root, "Try again");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(capturedVendorValue).toBe("");
  });

  it('failed (no chunks) → "Try again" clears AI raw log (count badge disappears)', async () => {
    installImmediateUploadTask("job-failed-2");

    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobId: "job-failed-2",
        status: "failed",
        totalPages: null,
        processedPages: 0,
        matchedParts: 0,
        imagesMatched: 0,
        errorMessage: "processing_error",
        failedChunks: [],
        aiRawLog: AI_LOG_ENTRIES,
      }),
    });

    const tree = await renderUploadCard();
    activeTree = tree;

    await pickFileSetVendorAndStart(tree);

    expect(instText(tree.root)).toContain("AI Raw · 2");

    const resetBtn = findPressable(tree.root, "Try again");
    expect(resetBtn).not.toBeNull();
    await act(async () => { resetBtn!.props.onPress(); });
    await flushPromises();

    expect(instText(tree.root)).not.toContain("AI Raw ·");
  });
});
