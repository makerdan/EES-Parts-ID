/**
 * @jest-environment node
 *
 * Unit tests for the FailedJobsSection component (extracted from
 * app/catalog-review.tsx) and the display utilities it depends on.
 *
 * Components are rendered by a lightweight recursive renderer that calls
 * each function component with its props, then collects every text string
 * from the resulting React element tree.  This avoids the deprecated
 * react-test-renderer API while still exercising the real component code.
 */

import React from "react";
import { FailedJobsSection } from "../components/FailedJobsSection";
import type { FailedJob, FailedJobsSectionColors } from "../components/FailedJobsSection";
import {
  FAILED_JOB_RESUBMIT_TEXT,
  displayErrorMessage,
  buildPageProgressFragment,
  buildFailedJobMetaLine,
} from "../utils/failedJobCard";

// ── Lightweight recursive renderer ────────────────────────────────────────────

/**
 * Recursively renders a React element tree by calling function components
 * with their props.  Collects every text string (and stringified number) that
 * would appear as visible content to the user.
 */
function collectText(node: React.ReactNode): string[] {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === "string") return [node];
  if (typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);

  if (!React.isValidElement(node)) return [];

  const el = node as React.ReactElement<{ children?: React.ReactNode }>;
  const { type, props } = el;

  if (typeof type === "function") {
    const rendered = (type as (p: typeof props) => React.ReactNode)(props);
    return collectText(rendered);
  }

  return collectText(props.children);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const TEST_COLORS: FailedJobsSectionColors = {
  card: "#ffffff",
  destructive: "#ef4444",
  foreground: "#0f172a",
  mutedForeground: "#64748b",
  primary: "#2563eb",
  muted: "#f1f5f9",
  border: "#e2e8f0",
};

function renderSection(
  jobs: FailedJob[],
  dismissingId: number | null = null,
  resumingId: number | null = null,
  resumeProgress: Record<number, import("../types/catalogPdf").ResumeProgress> = {},
) {
  const el = React.createElement(FailedJobsSection, {
    failedJobs: jobs,
    dismissingId,
    resumingId,
    resumeProgress,
    onDismiss: jest.fn(),
    onResume: jest.fn(),
    onReviewChanges: jest.fn(),
    onDismissResumeError: jest.fn(),
    onRetryPoll: jest.fn(),
    colors: TEST_COLORS,
  });
  const texts = collectText(el);
  return { texts, allText: texts.join(" ") };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_JOB: FailedJob = {
  id: 42,
  vendor: "ACME ELECTRIC",
  filename: "acme-catalog-2024.pdf",
  status: "failed",
  errorMessage: "PDF could not be parsed: unexpected end of stream",
  createdAt: "2025-01-15T12:00:00.000Z",
  finishedAt: null,
  processedPages: 0,
  totalPages: null,
  matchedParts: 0,
};

// ── Section visibility ────────────────────────────────────────────────────────

describe("FailedJobsSection — renders nothing when there are no failed jobs", () => {
  it("returns null when failedJobs is empty and no resume progress", () => {
    const el = React.createElement(FailedJobsSection, {
      failedJobs: [],
      dismissingId: null,
      resumingId: null,
      resumeProgress: {},
      onDismiss: jest.fn(),
      onResume: jest.fn(),
      onReviewChanges: jest.fn(),
      onDismissResumeError: jest.fn(),
      onRetryPoll: jest.fn(),
      colors: TEST_COLORS,
    });
    const result = (FailedJobsSection as (p: typeof el.props) => React.ReactNode)(el.props);
    expect(result).toBeNull();
  });
});

// ── Card content ──────────────────────────────────────────────────────────────

describe("FailedJobsSection — card content for a failed job", () => {
  it("renders the vendor name", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("ACME ELECTRIC");
  });

  it("renders the filename", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("acme-catalog-2024.pdf");
  });

  it("renders the 'Failed' status badge", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("Failed");
  });

  it("renders the error message from the job", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("PDF could not be parsed: unexpected end of stream");
  });

  it("renders 'Unknown error' when errorMessage is null", () => {
    const { texts } = renderSection([{ ...MOCK_JOB, errorMessage: null }]);
    expect(texts).toContain("Unknown error");
  });

  it("renders the Resume button", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("Resume");
  });

  it("renders the Dismiss button", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain("Dismiss");
  });

  it("renders 'Dismissing…' while a dismiss is in progress for this job", () => {
    const { texts } = renderSection([MOCK_JOB], MOCK_JOB.id);
    expect(texts).toContain("Dismissing…");
    expect(texts).not.toContain("Dismiss");
  });

  it("still shows 'Dismiss' for other jobs while one is being dismissed", () => {
    const other: FailedJob = { ...MOCK_JOB, id: 99 };
    const { texts } = renderSection([MOCK_JOB, other], MOCK_JOB.id);
    expect(texts).toContain("Dismissing…");
    expect(texts).toContain("Dismiss");
  });
});

// ── Section header ────────────────────────────────────────────────────────────

describe("FailedJobsSection — section header text", () => {
  it("shows '1 Failed Job' (singular) for a single failure", () => {
    const { texts } = renderSection([MOCK_JOB]);
    // The number and text are separate React nodes; join without separator to
    // verify the concatenated result matches what the user sees.
    const joined = texts.join("");
    expect(joined).toContain("1 Failed Job");
    expect(joined).not.toContain("1 Failed Jobs");
  });

  it("shows '2 Failed Jobs' (plural) for two failures", () => {
    const { texts } = renderSection([MOCK_JOB, { ...MOCK_JOB, id: 2 }]);
    const joined = texts.join("");
    expect(joined).toContain("2 Failed Jobs");
  });

  it("section hint mentions 'Resume'", () => {
    const { allText } = renderSection([MOCK_JOB]);
    expect(allText).toContain("Resume");
  });

  it("section hint mentions 'Upload tab'", () => {
    const { allText } = renderSection([MOCK_JOB]);
    expect(allText).toContain("Upload tab");
  });
});

// ── Display utilities (utils/failedJobCard.ts) ────────────────────────────────

describe("FAILED_JOB_RESUBMIT_TEXT — exact wording", () => {
  it("matches the exact string rendered by the component", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toBe(
      'To resubmit: go to the Upload tab, enter the vendor name, select the same PDF, and tap "Start Extraction".',
    );
  });
});

describe("displayErrorMessage", () => {
  it("returns the errorMessage when it is set", () => {
    expect(displayErrorMessage({ errorMessage: "Timeout" })).toBe("Timeout");
  });

  it("falls back to 'Unknown error' when errorMessage is null", () => {
    expect(displayErrorMessage({ errorMessage: null })).toBe("Unknown error");
  });

  it("returns empty string as-is since ?? only catches null/undefined", () => {
    expect(displayErrorMessage({ errorMessage: "" })).toBe("");
  });
});

describe("buildPageProgressFragment", () => {
  it("returns '' when processedPages is 0", () => {
    expect(buildPageProgressFragment({ processedPages: 0, totalPages: 10 })).toBe("");
  });

  it("includes both counts when processedPages > 0 and totalPages is known", () => {
    expect(buildPageProgressFragment({ processedPages: 3, totalPages: 10 })).toBe(
      " · 3/10 pages processed",
    );
  });

  it("omits the total when totalPages is null", () => {
    expect(buildPageProgressFragment({ processedPages: 5, totalPages: null })).toBe(
      " · 5 pages processed",
    );
  });
});

describe("buildFailedJobMetaLine", () => {
  it("starts with 'Job #<id>'", () => {
    const line = buildFailedJobMetaLine({ id: 42, createdAt: "2025-01-15T00:00:00.000Z", processedPages: 0, totalPages: null });
    expect(line).toMatch(/^Job #42 · /);
  });

  it("appends page progress when processedPages > 0", () => {
    const line = buildFailedJobMetaLine({ id: 1, createdAt: "2025-01-15T00:00:00.000Z", processedPages: 4, totalPages: 12 });
    expect(line).toContain("4/12 pages processed");
  });
});

// ── Re-failed card (resumed job that fails again) ─────────────────────────────

describe("FailedJobsSection — re-failed progress card", () => {
  const REFAILED_PROGRESS: import("../types/catalogPdf").ResumeProgress = {
    status: "failed",
    processedPages: 3,
    totalPages: 10,
    matchedParts: 0,
    errorMessage: "Page 4 was corrupt and could not be processed.",
  };

  it("renders 'Failed again' badge when resumeProgress has status failed", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("Failed again");
  });

  it("shows the new errorMessage from resumeProgress, not the old one from the job", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("Page 4 was corrupt and could not be processed.");
    expect(texts).not.toContain("PDF could not be parsed: unexpected end of stream");
  });

  it("renders a Dismiss button on the re-failed card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("Dismiss");
  });

  it("renders a Resume button on the re-failed card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("Resume");
  });

  it("calls onResume when Resume is tapped on the re-failed card", () => {
    const onResume = jest.fn();
    const onDismissResumeError = jest.fn();
    const el = React.createElement(FailedJobsSection, {
      failedJobs: [MOCK_JOB],
      dismissingId: null,
      resumingId: null,
      resumeProgress: { [MOCK_JOB.id]: REFAILED_PROGRESS },
      onDismiss: jest.fn(),
      onResume,
      onReviewChanges: jest.fn(),
      onDismissResumeError,
      onRetryPoll: jest.fn(),
      colors: TEST_COLORS,
    });
    // Walk the element tree to find the Resume button's onPress and call it.
    // Check onPress BEFORE rendering function components so Pressable (which is
    // a function component in the test environment) is matched by its props,
    // not by its rendered output.  Must handle arrays the same way collectText
    // does — children from .map() calls arrive as nested arrays.
    function findAndPressResume(node: React.ReactNode): boolean {
      if (node === null || node === undefined || node === false) return false;
      if (Array.isArray(node)) {
        for (const child of node) {
          if (findAndPressResume(child)) return true;
        }
        return false;
      }
      if (!React.isValidElement(node)) return false;
      const el = node as React.ReactElement<any>;
      const { type, props } = el;
      // Match first: an element with onPress whose subtree contains "Resume"
      if (props.onPress && collectText(node).includes("Resume")) {
        props.onPress();
        return true;
      }
      if (typeof type === "function") {
        const rendered = (type as (p: typeof props) => React.ReactNode)(props);
        return findAndPressResume(rendered);
      }
      if (props.children) {
        return findAndPressResume(props.children);
      }
      return false;
    }
    findAndPressResume(el);
    expect(onResume).toHaveBeenCalledWith(MOCK_JOB.id);
    expect(onDismissResumeError).toHaveBeenCalledWith(MOCK_JOB.id);
  });

  it("does NOT count the re-failed job in the Failed Jobs section header", () => {
    const { allText } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(allText).not.toContain("Failed Job");
  });

  it("falls back to default message when errorMessage is null in progress", () => {
    const prog = { ...REFAILED_PROGRESS, errorMessage: null };
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: prog });
    expect(texts).toContain("The job failed again. Try resuming with the correct PDF.");
  });

  it("shows the vendor name on the re-failed card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("ACME ELECTRIC");
  });

  it("shows the filename on the re-failed card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).toContain("acme-catalog-2024.pdf");
  });

  it("does not render a plain Failed badge alongside the re-failed card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: REFAILED_PROGRESS });
    expect(texts).not.toContain("Failed");
  });
});

// ── Mid-loop chunk failure leaves card actionable ──────────────────────────────
// Simulates what handleResume does when a chunk upload fails mid-loop:
// it sets resumeProgress[jobId] to status "failed" with an errorMessage.
// The card must show Resume + Dismiss so the admin is not stuck.

describe("FailedJobsSection — mid-loop chunk failure leaves card actionable", () => {
  const MID_LOOP_FAIL_PROGRESS: import("../types/catalogPdf").ResumeProgress = {
    status: "failed",
    processedPages: 0,
    totalPages: null,
    matchedParts: 0,
    errorMessage: "Could not resume a chunk. Please try again.",
  };

  it("renders 'Failed again' badge after a mid-loop chunk error", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: MID_LOOP_FAIL_PROGRESS });
    expect(texts).toContain("Failed again");
  });

  it("shows the chunk error message on the card", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: MID_LOOP_FAIL_PROGRESS });
    expect(texts).toContain("Could not resume a chunk. Please try again.");
  });

  it("renders a Resume button so admin can retry after chunk failure", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: MID_LOOP_FAIL_PROGRESS });
    expect(texts).toContain("Resume");
  });

  it("renders a Dismiss button so admin can clear the card after chunk failure", () => {
    const { texts } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: MID_LOOP_FAIL_PROGRESS });
    expect(texts).toContain("Dismiss");
  });

  it("does not show an 'Uploading' badge — card must not remain stuck mid-upload", () => {
    const { allText } = renderSection([MOCK_JOB], null, null, { [MOCK_JOB.id]: MID_LOOP_FAIL_PROGRESS });
    expect(allText).not.toContain("Uploading");
  });
});
