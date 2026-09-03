/**
 * @jest-environment node
 *
 * Integration tests for the error-handling branches in catalog-review.tsx
 * that fire when the status endpoint returns a non-2xx response.
 *
 * These tests render the real CatalogReviewScreen component.  Fetch responses
 * drive the production code paths directly so that if those paths are removed,
 * renamed, or the error messages changed, the tests fail immediately.
 *
 * Guarded behaviours
 * ──────────────────
 * A) fetchItems — deep-link status fetch (jobId param present):
 *    When the second parallel request — /admin/catalog-pdf/:id/status — returns
 *    non-ok, the component must render the error string
 *    "Could not load job status — try refreshing." instead of silently
 *    swallowing the failure.
 *
 * B) handleResume — large-PDF path (pdfBytes > 20 MB):
 *    Before uploading chunks the handler fetches /status to discover which
 *    chunks need re-sending.  A non-ok response must open the InfoDialog with
 *    title "Resume failed" and a message containing the HTTP status code.
 *    The dialog must NOT say "No resumable chunks found".
 *
 * C) handleResume — post-409 path (small PDF, resume endpoint returns 409):
 *    After the 409 the handler fetches /status to get the failed chunk list.
 *    A non-ok response must open InfoDialog with the same "Resume failed" /
 *    HTTP-status wording.
 */

// Required for act() to work correctly in the node environment.
// @ts-ignore — global augmentation for test environment only
global.IS_REACT_ACT_ENVIRONMENT = true;

// ── expo-router ───────────────────────────────────────────────────────────────

const mockRouterBack = jest.fn();
const mockUseLocalSearchParams = jest.fn(() => ({} as Record<string, string | undefined>));

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockRouterBack, push: jest.fn() }),
  useLocalSearchParams: <T extends Record<string, string | undefined>>(): T =>
    mockUseLocalSearchParams() as T,
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

// ── @tanstack/react-query ─────────────────────────────────────────────────────

jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn().mockResolvedValue(undefined) }),
}));

// ── @/hooks/useColors ─────────────────────────────────────────────────────────

jest.mock("@/hooks/useColors", () => require("./helpers/mapMocks").createUseColorsMock());

// ── @/utils/* ─────────────────────────────────────────────────────────────────

const mockReadPdfAsBytes = jest.fn<Promise<Uint8Array>, [string, (File | undefined)?]>();

jest.mock("@/utils/readPdfAsBase64", () => ({
  readPdfAsBytes: (...args: unknown[]) =>
    mockReadPdfAsBytes(...(args as [string, (File | undefined)?])),
  toFriendlyReadError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

const mockSplitPdfIntoChunks = jest.fn();

jest.mock("@/utils/splitPdfIntoChunks", () => ({
  splitPdfIntoChunks: (...args: unknown[]) => mockSplitPdfIntoChunks(...args),
  PAGES_PER_CHUNK: 20,
}));

jest.mock("@/utils/apiBase", () => ({ API_BASE: "http://test-api/api" }));

jest.mock("@/utils/aiFallbackHeaders", () => ({
  buildResumeHeaders: (headers: Record<string, string>) => headers,
  shouldUseFallback: jest.fn(() => false),
}));

jest.mock("@/utils/editItemCache", () => ({
  invalidateListCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/utils/addToInventory", () => ({
  performAddToInventory: jest.fn(),
}));

jest.mock("@/utils/updateDescription", () => ({
  performUpdateDescription: jest.fn(),
}));

jest.mock("@/utils/binValidation", () => ({
  BIN_FORMAT_HINT: "AA-000",
  isBinLocationValid: jest.fn(() => true),
}));

jest.mock("@/utils/useTrackScreen", () => ({ useTrackScreen: jest.fn() }));

// ── @/components/* ────────────────────────────────────────────────────────────
//
// InfoDialog: capture props so tests can assert on visible/title/message
// without needing a real Modal.

let capturedInfoDialogProps: { visible: boolean; title: string; message: string } = {
  visible: false,
  title: "",
  message: "",
};

jest.mock("@/components/ConfirmDialog", () => ({
  InfoDialog: (props: {
    visible: boolean;
    title: string;
    message: string;
    onDismiss?: () => void;
  }) => {
    capturedInfoDialogProps = {
      visible: props.visible,
      title: props.title,
      message: props.message,
    };
    return null;
  },
}));

// FailedJobsSection: capture the onResume callback so tests can trigger it
// without needing to interact with the full card UI.

let capturedOnResume: ((jobId: number) => void) | null = null;
let capturedSetResumeProgress: jest.Mock;

jest.mock("@/components/FailedJobsSection", () => ({
  FailedJobsSection: (props: {
    onResume: (id: number) => void;
    failedJobs: unknown[];
    [k: string]: unknown;
  }) => {
    capturedOnResume = props.onResume;
    return null;
  },
}));

jest.mock("@/components/RetryImage", () => ({ RetryImage: () => null }));

// ── Imports (after all jest.mock calls) ───────────────────────────────────────

import React from "react";
import { render, act } from "@testing-library/react-native";
import CatalogReviewScreen from "../app/catalog-review";
import { makeAppMock, flushPromises } from "./helpers/appMocks";

// AppContext is auto-mocked via jest.config.js → __mocks__/contexts/AppContext.js
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApp } = require("@/contexts/AppContext") as { useApp: jest.Mock };

// ApiHealthContext is auto-mocked via jest.config.js → __mocks__/contexts/ApiHealthContext.js
// We need to call mockReturnValue() with a STABLE object (same references on
// every render) so that `reportNetworkFailure` does not change identity and
// cause the `fetchItems` useCallback to re-create itself, which would trigger
// its useEffect on every render and produce an infinite fetch-state-update loop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { useApiHealth } = require("@/contexts/ApiHealthContext") as {
  useApiHealth: jest.Mock;
};
const stableApiHealth = {
  status: "ok" as const,
  restarting: false,
  reportNetworkFailure: jest.fn(),
  triggerRestart: jest.fn().mockResolvedValue(undefined),
  checkStatus: jest.fn().mockResolvedValue(undefined),
  bots: {},
  probeSingleBot: jest.fn().mockResolvedValue(undefined),
};

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Minimal fake Response satisfying the ok / status / json contract. */
function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Failed job fixture used for handleResume tests. */
const MOCK_FAILED_JOB = {
  id: 42,
  vendor: "ACME ELECTRIC",
  filename: "acme-catalog.pdf",
  status: "failed",
  errorMessage: "Extraction error",
  createdAt: "2025-01-01T00:00:00.000Z",
  finishedAt: null,
  processedPages: 0,
  totalPages: null,
  matchedParts: 0,
};

/**
 * Flush the microtask queue (up to 10 iterations) inside an act() block.
 * This allows async state updates triggered by mocked fetch responses to
 * settle before assertions are made.
 */
const flush = () => act(async () => { await flushPromises(); });

// ── Global test lifecycle ─────────────────────────────────────────────────────

type RenderResult = Awaited<ReturnType<typeof render>>;
let activeTree: RenderResult | null = null;

beforeEach(() => {
  capturedInfoDialogProps = { visible: false, title: "", message: "" };
  capturedOnResume = null;
  capturedSetResumeProgress = jest.fn();
  jest.clearAllMocks();

  // Provide the full AppContext value that CatalogReviewScreen needs.
  useApp.mockReturnValue(
    makeAppMock({
      adminToken: "test-admin-tok",
      isAdmin: true,
      resumeProgress: {},
      setResumeProgress: capturedSetResumeProgress,
    }),
  );

  // Pin a stable return value so reportNetworkFailure has the same function
  // reference on every render.  Without this, fetchItems' useCallback recreates
  // itself every render because reportNetworkFailure is a dependency, which
  // triggers its useEffect every render → infinite fetch loop → test timeout.
  useApiHealth.mockReturnValue(stableApiHealth);
});

afterEach(async () => {
  if (activeTree) {
    await activeTree.unmount();
    activeTree = null;
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ══════════════════════════════════════════════════════════════════════════════
// A — fetchItems: deep-link status fetch returns non-ok
//
// When jobId is in the URL params, fetchItems fires two parallel requests:
//   1. /admin/catalog-pdf/reviews?jobId=<id>  (review list)
//   2. /admin/catalog-pdf/<id>/status          (job summary)
//
// If request 2 returns non-ok (and non-401), the component must set its error
// state and render "Could not load job status — try refreshing.".
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogReviewScreen — deep-link status fetch returns non-ok", () => {
  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({ jobId: "42" });
  });

  function setupFetchWithStatusCode(statusCode: number): void {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/reviews"))
        return Promise.resolve(makeResponse(200, { items: [] }));
      if (url.includes("/status"))
        return Promise.resolve(makeResponse(statusCode));
      return Promise.resolve(makeResponse(404));
    });
  }

  it("renders the error string when the status endpoint returns 500", async () => {
    setupFetchWithStatusCode(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    expect(
      activeTree.getByText("Could not load job status — try refreshing."),
    ).toBeTruthy();
  });

  it("renders the error string when the status endpoint returns 404", async () => {
    setupFetchWithStatusCode(404);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    expect(
      activeTree.getByText("Could not load job status — try refreshing."),
    ).toBeTruthy();
  });

  it("renders the error string when the status endpoint returns 503", async () => {
    setupFetchWithStatusCode(503);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    expect(
      activeTree.getByText("Could not load job status — try refreshing."),
    ).toBeTruthy();
  });

  it("does NOT render the job-status error when the status endpoint returns 200", async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/reviews"))
        return Promise.resolve(makeResponse(200, { items: [] }));
      if (url.includes("/status"))
        return Promise.resolve(
          makeResponse(200, {
            status: "done",
            vendor: "ACME",
            partsFound: 5,
            matchedParts: 5,
            imagesMatched: 3,
            unmatchedParts: [],
          }),
        );
      return Promise.resolve(makeResponse(404));
    });

    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    expect(
      activeTree.queryByText("Could not load job status — try refreshing."),
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B — handleResume: large-PDF path — status fetch returns non-ok
//
// When the PDF is >20 MB, handleResume splits it into chunks and then fetches
// /status to find out which chunks failed.  A non-ok status response must open
// InfoDialog with title "Resume failed" and an "HTTP <code>" message; the
// "No resumable chunks found" branch must NOT be reached.
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogReviewScreen — handleResume large-PDF status fetch returns non-ok", () => {
  /**
   * Returns a Uint8Array whose .length property reports 21 MB without
   * actually allocating that memory, so the CHUNK_SIZE_THRESHOLD branch
   * in handleResume is taken.  The actual bytes are never accessed because
   * splitPdfIntoChunks is mocked.
   */
  function fakeLargeBytes(): Uint8Array {
    return new Proxy(new Uint8Array(8), {
      get(target, prop, receiver) {
        if (prop === "length") return 21 * 1024 * 1024;
        return Reflect.get(target, prop, receiver);
      },
    }) as Uint8Array;
  }

  function setupFetchForLargeResume(statusCode: number): void {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/failed-jobs"))
        return Promise.resolve(makeResponse(200, { jobs: [MOCK_FAILED_JOB] }));
      if (url.includes("/reviews"))
        return Promise.resolve(makeResponse(200, { items: [] }));
      // Both the on-mount poll check and the resume-phase status fetch
      // hit this branch.
      if (url.includes("/status"))
        return Promise.resolve(makeResponse(statusCode));
      return Promise.resolve(makeResponse(404));
    });
  }

  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({});

    // Picker succeeds and returns a PDF asset URI.
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///catalog.pdf", name: "catalog.pdf" }],
    });

    // readPdfAsBytes returns a proxy whose length reports > 20 MB.
    mockReadPdfAsBytes.mockResolvedValue(fakeLargeBytes());

    // splitPdfIntoChunks returns one fake chunk so it doesn't throw.
    mockSplitPdfIntoChunks.mockResolvedValue([
      { bytes: new Uint8Array(8), pageOffset: 0, pageCount: 20 },
    ]);
  });

  it("opens InfoDialog with 'Resume failed' title when status returns 500", async () => {
    setupFetchForLargeResume(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush(); // settle mount fetch

    expect(capturedOnResume).not.toBeNull();
    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.visible).toBe(true);
    expect(capturedInfoDialogProps.title).toBe("Resume failed");
  });

  it("includes 'HTTP 500' in the InfoDialog message when status returns 500", async () => {
    setupFetchForLargeResume(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.message).toContain("HTTP 500");
    expect(capturedInfoDialogProps.message).toContain("Please try again");
  });

  it("includes 'HTTP 404' in the InfoDialog message when status returns 404", async () => {
    setupFetchForLargeResume(404);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.visible).toBe(true);
    expect(capturedInfoDialogProps.message).toContain("HTTP 404");
  });

  it("does NOT show 'No resumable chunks found' when status is non-ok", async () => {
    setupFetchForLargeResume(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.message).not.toContain(
      "No resumable chunks found",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C — handleResume: post-409 path — status fetch returns non-ok
//
// For a small PDF (<20 MB), handleResume POSTs to the /resume endpoint.  If
// the server returns 409 (chunked job), the handler then fetches /status to
// get the failed chunk list.  A non-ok status response must open InfoDialog
// with title "Resume failed" and an "HTTP <code>" message.
// ══════════════════════════════════════════════════════════════════════════════

describe("CatalogReviewScreen — handleResume post-409 status fetch returns non-ok", () => {
  function setupFetchForPost409(statusCode: number): void {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/failed-jobs"))
        return Promise.resolve(makeResponse(200, { jobs: [MOCK_FAILED_JOB] }));
      if (url.includes("/reviews"))
        return Promise.resolve(makeResponse(200, { items: [] }));
      // The single-payload resume endpoint returns 409 to signal a chunked job.
      if (url.includes("/resume"))
        return Promise.resolve(makeResponse(409));
      // The subsequent status fetch is what we're testing.
      if (url.includes("/status"))
        return Promise.resolve(makeResponse(statusCode));
      return Promise.resolve(makeResponse(404));
    });
  }

  beforeEach(() => {
    mockUseLocalSearchParams.mockReturnValue({});

    // Picker succeeds.
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///catalog.pdf", name: "catalog.pdf" }],
    });

    // readPdfAsBytes returns a small PDF (4 bytes — well under 20 MB).
    mockReadPdfAsBytes.mockResolvedValue(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
  });

  it("opens InfoDialog with 'Resume failed' title when post-409 status returns 500", async () => {
    setupFetchForPost409(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush(); // settle mount fetch

    expect(capturedOnResume).not.toBeNull();
    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.visible).toBe(true);
    expect(capturedInfoDialogProps.title).toBe("Resume failed");
  });

  it("includes 'HTTP 500' in the InfoDialog message when post-409 status returns 500", async () => {
    setupFetchForPost409(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.message).toContain("HTTP 500");
    expect(capturedInfoDialogProps.message).toContain("Please try again");
  });

  it("includes 'HTTP 503' in the InfoDialog message when post-409 status returns 503", async () => {
    setupFetchForPost409(503);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.visible).toBe(true);
    expect(capturedInfoDialogProps.message).toContain("HTTP 503");
  });

  it("does NOT show 'No resumable chunks found' when post-409 status is non-ok", async () => {
    setupFetchForPost409(500);
    activeTree = await render(<CatalogReviewScreen />);
    await flush();

    await act(async () => {
      capturedOnResume!(MOCK_FAILED_JOB.id);
      await flushPromises();
    });

    expect(capturedInfoDialogProps.message).not.toContain(
      "No resumable chunks found",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D — lifecycle cancellation
//
// Bootstrap and resume-poll requests can outlive the screen.  They must carry
// an AbortSignal and ignore late responses so abandoned screens do not update
// state or restart follow-up work.
// ══════════════════════════════════════════════════════════════════════════════

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CatalogReviewScreen — lifecycle cancellation", () => {
  it("aborts review and failed-job bootstrap requests on unmount", async () => {
    mockUseLocalSearchParams.mockReturnValue({});
    const reviewResponse = deferred<Response>();
    const failedJobsResponse = deferred<Response>();
    const signals: AbortSignal[] = [];

    global.fetch = jest.fn().mockImplementation((url: string, options?: RequestInit) => {
      signals.push(options?.signal as AbortSignal);
      return url.includes("/reviews")
        ? reviewResponse.promise
        : failedJobsResponse.promise;
    });

    activeTree = await render(<CatalogReviewScreen />);
    expect(signals).toHaveLength(2);

    await activeTree.unmount();
    activeTree = null;

    expect(signals.every((signal) => signal.aborted)).toBe(true);

    reviewResponse.resolve(makeResponse(200, { items: [] }));
    failedJobsResponse.resolve(makeResponse(200, { jobs: [] }));
    await flush();

    expect(capturedSetResumeProgress).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores a late deep-link response after the admin token changes", async () => {
    mockUseLocalSearchParams.mockReturnValue({ jobId: "42" });
    const oldReviewResponse = deferred<Response>();
    const oldStatusResponse = deferred<Response>();
    const signals: AbortSignal[] = [];
    let requestCount = 0;

    global.fetch = jest.fn().mockImplementation((url: string, options?: RequestInit) => {
      signals.push(options?.signal as AbortSignal);
      requestCount += 1;
      if (requestCount === 1) return oldReviewResponse.promise;
      if (requestCount === 2) return oldStatusResponse.promise;
      return Promise.resolve(
        url.includes("/reviews")
          ? makeResponse(200, { items: [] })
          : makeResponse(200, { status: "done", unmatchedParts: [] }),
      );
    });

    const oldSetResumeProgress = capturedSetResumeProgress;
    activeTree = await render(<CatalogReviewScreen />);

    useApp.mockReturnValue(
      makeAppMock({
        adminToken: "new-admin-token",
        isAdmin: true,
        resumeProgress: {},
        setResumeProgress: jest.fn(),
      }),
    );
    await activeTree.rerender(<CatalogReviewScreen />);

    expect(signals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);

    oldReviewResponse.resolve(makeResponse(200, { items: [] }));
    oldStatusResponse.resolve(makeResponse(200, {
      status: "processing",
      processedPages: 1,
      totalPages: 2,
      matchedParts: 1,
      unmatchedParts: [],
    }));
    await flush();

    expect(oldSetResumeProgress).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("aborts an in-flight resume poll and does not refresh after unmount", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    mockUseLocalSearchParams.mockReturnValue({});
    const pollResponse = deferred<Response>();
    const pollSignals: AbortSignal[] = [];

    global.fetch = jest.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/status")) {
        pollSignals.push(options?.signal as AbortSignal);
        return pollResponse.promise;
      }
      return Promise.resolve(
        url.includes("/reviews")
          ? makeResponse(200, { items: [] })
          : makeResponse(200, { jobs: [] }),
      );
    });

    useApp.mockReturnValue(
      makeAppMock({
        adminToken: "test-admin-tok",
        isAdmin: true,
        resumeProgress: {
          42: {
            status: "processing",
            processedPages: 1,
            totalPages: 2,
            matchedParts: 0,
            errorMessage: null,
          },
        },
        setResumeProgress: capturedSetResumeProgress,
      }),
    );
    activeTree = await render(
      <CatalogReviewScreen />,
    );
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(pollSignals).toHaveLength(1);

    await activeTree.unmount();
    activeTree = null;
    expect(pollSignals[0]!.aborted).toBe(true);

    pollResponse.resolve(makeResponse(200, {
      status: "done",
      processedPages: 2,
      totalPages: 2,
      matchedParts: 1,
      errorMessage: null,
    }));
    await flush();

    expect(capturedSetResumeProgress).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
