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
};

function renderSection(jobs: FailedJob[], dismissingId: number | null = null) {
  const el = React.createElement(FailedJobsSection, {
    failedJobs: jobs,
    dismissingId,
    onDismiss: jest.fn(),
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
  it("returns null when failedJobs is empty", () => {
    const el = React.createElement(FailedJobsSection, {
      failedJobs: [],
      dismissingId: null,
      onDismiss: jest.fn(),
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

  it("renders the exact FAILED_JOB_RESUBMIT_TEXT", () => {
    const { texts } = renderSection([MOCK_JOB]);
    expect(texts).toContain(FAILED_JOB_RESUBMIT_TEXT);
  });

  it("resubmit text contains 'Upload tab'", () => {
    const { allText } = renderSection([MOCK_JOB]);
    expect(allText).toContain("Upload tab");
  });

  it("resubmit text contains 'Start Extraction'", () => {
    const { allText } = renderSection([MOCK_JOB]);
    expect(allText).toContain("Start Extraction");
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
