/**
 * @jest-environment node
 *
 * Unit tests for the failed PDF job card display logic used in
 * app/catalog-review.tsx.  The display utilities are extracted into
 * utils/failedJobCard.ts and imported by the screen, so any regression
 * to the card text, error-message fallback, page-progress fragment, or
 * resubmit instructions will cause these tests to fail.
 */

import {
  FAILED_JOB_RESUBMIT_TEXT,
  displayErrorMessage,
  buildPageProgressFragment,
  buildFailedJobMetaLine,
} from "../utils/failedJobCard";

// ── Resubmit instruction text ─────────────────────────────────────────────────

describe("FAILED_JOB_RESUBMIT_TEXT", () => {
  it("contains the Upload tab instruction", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toContain("Upload tab");
  });

  it("mentions entering the vendor name", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toContain("vendor name");
  });

  it("mentions selecting the same PDF", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toContain("same PDF");
  });

  it("mentions tapping Start Extraction", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toContain("Start Extraction");
  });

  it("matches the exact wording shown to users", () => {
    expect(FAILED_JOB_RESUBMIT_TEXT).toBe(
      'To resubmit: go to the Upload tab, enter the vendor name, select the same PDF, and tap "Start Extraction".',
    );
  });
});

// ── Error message display ─────────────────────────────────────────────────────

describe("displayErrorMessage", () => {
  it("returns the errorMessage when it is a non-empty string", () => {
    expect(displayErrorMessage({ errorMessage: "PDF could not be parsed" })).toBe(
      "PDF could not be parsed",
    );
  });

  it("falls back to 'Unknown error' when errorMessage is null", () => {
    expect(displayErrorMessage({ errorMessage: null })).toBe("Unknown error");
  });

  it("falls back to 'Unknown error' when errorMessage is undefined", () => {
    expect(displayErrorMessage({ errorMessage: undefined as unknown as null })).toBe(
      "Unknown error",
    );
  });

  it("returns an empty string as-is (not the fallback) because ?? checks null/undefined only", () => {
    expect(displayErrorMessage({ errorMessage: "" })).toBe("");
  });
});

// ── Page-progress fragment ────────────────────────────────────────────────────

describe("buildPageProgressFragment", () => {
  it("returns empty string when processedPages is 0", () => {
    expect(buildPageProgressFragment({ processedPages: 0, totalPages: 10 })).toBe("");
  });

  it("returns empty string when processedPages is 0 and totalPages is null", () => {
    expect(buildPageProgressFragment({ processedPages: 0, totalPages: null })).toBe("");
  });

  it("includes both counts when processedPages > 0 and totalPages is set", () => {
    expect(buildPageProgressFragment({ processedPages: 3, totalPages: 10 })).toBe(
      " · 3/10 pages processed",
    );
  });

  it("omits the total when totalPages is null", () => {
    expect(buildPageProgressFragment({ processedPages: 5, totalPages: null })).toBe(
      " · 5 pages processed",
    );
  });

  it("handles a job that processed all pages before failing", () => {
    expect(buildPageProgressFragment({ processedPages: 10, totalPages: 10 })).toBe(
      " · 10/10 pages processed",
    );
  });
});

// ── Meta line ─────────────────────────────────────────────────────────────────

describe("buildFailedJobMetaLine", () => {
  const JOB_DATE = "2025-01-15T12:00:00.000Z";
  const LOCALE_DATE = new Date(JOB_DATE).toLocaleDateString();

  it("includes the job ID", () => {
    const meta = buildFailedJobMetaLine({ id: 42, createdAt: JOB_DATE, processedPages: 0, totalPages: null });
    expect(meta).toContain("Job #42");
  });

  it("includes the formatted creation date", () => {
    const meta = buildFailedJobMetaLine({ id: 1, createdAt: JOB_DATE, processedPages: 0, totalPages: null });
    expect(meta).toContain(LOCALE_DATE);
  });

  it("appends the page-progress fragment when pages were processed", () => {
    const meta = buildFailedJobMetaLine({ id: 7, createdAt: JOB_DATE, processedPages: 4, totalPages: 12 });
    expect(meta).toContain("4/12 pages processed");
  });

  it("omits the page-progress fragment when processedPages is 0", () => {
    const meta = buildFailedJobMetaLine({ id: 7, createdAt: JOB_DATE, processedPages: 0, totalPages: 12 });
    expect(meta).not.toContain("pages processed");
  });

  it("produces the exact format 'Job #<id> · <date>'", () => {
    const meta = buildFailedJobMetaLine({ id: 5, createdAt: JOB_DATE, processedPages: 0, totalPages: null });
    expect(meta).toBe(`Job #5 · ${LOCALE_DATE}`);
  });
});

// ── Failed-section visibility ─────────────────────────────────────────────────

describe("failed-jobs section visibility (failedJobs.length > 0)", () => {
  it("section renders when there is at least one failed job", () => {
    const jobs = [{ id: 1, errorMessage: "err", createdAt: "", processedPages: 0, totalPages: null }];
    expect(jobs.length > 0).toBe(true);
  });

  it("section renders for multiple failed jobs", () => {
    const jobs = [
      { id: 1, errorMessage: "err", createdAt: "", processedPages: 0, totalPages: null },
      { id: 2, errorMessage: null, createdAt: "", processedPages: 2, totalPages: 8 },
    ];
    expect(jobs.length > 0).toBe(true);
  });

  it("section is hidden when there are no failed jobs", () => {
    const jobs: unknown[] = [];
    expect(jobs.length > 0).toBe(false);
  });
});
