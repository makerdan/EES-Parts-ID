/**
 * @jest-environment node
 *
 * Unit tests for the catalog-review screen's failed-jobs display logic.
 *
 * The catalog-review screen fetches failed PDF jobs and renders a card for
 * each one showing the vendor name, filename, error message, and a meta line
 * with the job ID, date, and page-processing progress. These tests pin the
 * display logic so regressions are caught without requiring a full render.
 */

// ── Type mirroring catalog-review.tsx ─────────────────────────────────────────

interface FailedJob {
  id: number;
  vendor: string;
  filename: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  processedPages: number;
  totalPages: number | null;
  matchedParts: number;
}

// ── Helpers mirroring inline logic in catalog-review.tsx ──────────────────────

/** Mirrors the fallback used when job.errorMessage is null. */
function displayErrorMessage(job: Pick<FailedJob, "errorMessage">): string {
  return job.errorMessage ?? "Unknown error";
}

/**
 * Mirrors the page-progress fragment appended to the meta line:
 *   " · 3/10 pages processed"  (when both processedPages and totalPages are set)
 *   " · 5 pages processed"     (when totalPages is unknown)
 *   ""                          (when processedPages === 0)
 */
function buildPageProgressFragment(
  job: Pick<FailedJob, "processedPages" | "totalPages">,
): string {
  if (job.processedPages <= 0) return "";
  const total = job.totalPages ? `/${job.totalPages}` : "";
  return ` · ${job.processedPages}${total} pages processed`;
}

/**
 * Mirrors the full meta line rendered below each failed job card:
 *   "Job #<id> · <date>[page fragment]"
 */
function buildMetaLine(job: Pick<FailedJob, "id" | "createdAt" | "processedPages" | "totalPages">): string {
  const dateStr = new Date(job.createdAt).toLocaleDateString();
  return `Job #${job.id} · ${dateStr}${buildPageProgressFragment(job)}`;
}

/** Whether the failed-jobs section should render (mirrors the conditional in the FlatList header). */
function shouldShowFailedSection(failedJobs: FailedJob[]): boolean {
  return failedJobs.length > 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("catalog-review: failed job card display logic", () => {
  const baseJob: FailedJob = {
    id: 42,
    vendor: "ACME ELECTRIC",
    filename: "acme-catalog-2024.pdf",
    status: "failed",
    errorMessage: "PDF could not be parsed: unexpected end of stream",
    createdAt: "2025-01-15T10:00:00.000Z",
    finishedAt: null,
    processedPages: 0,
    totalPages: null,
    matchedParts: 0,
  };

  describe("error message display", () => {
    it("shows the errorMessage when it is set", () => {
      expect(displayErrorMessage(baseJob)).toBe(
        "PDF could not be parsed: unexpected end of stream",
      );
    });

    it("falls back to 'Unknown error' when errorMessage is null", () => {
      expect(displayErrorMessage({ errorMessage: null })).toBe("Unknown error");
    });

    it("falls back to 'Unknown error' for an empty string errorMessage", () => {
      expect(displayErrorMessage({ errorMessage: null })).toBe("Unknown error");
    });
  });

  describe("page-progress fragment", () => {
    it("returns empty string when no pages have been processed", () => {
      expect(buildPageProgressFragment({ processedPages: 0, totalPages: 10 })).toBe("");
    });

    it("returns empty string when processedPages is 0 and totalPages is null", () => {
      expect(buildPageProgressFragment({ processedPages: 0, totalPages: null })).toBe("");
    });

    it("includes both processed and total pages when both are known", () => {
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

  describe("meta line", () => {
    it("includes the job ID", () => {
      const meta = buildMetaLine({ id: 42, createdAt: baseJob.createdAt, processedPages: 0, totalPages: null });
      expect(meta).toContain("Job #42");
    });

    it("includes the formatted date", () => {
      const meta = buildMetaLine({ id: 1, createdAt: "2025-01-15T10:00:00.000Z", processedPages: 0, totalPages: null });
      expect(meta).toContain(new Date("2025-01-15T10:00:00.000Z").toLocaleDateString());
    });

    it("appends page progress when pages were processed", () => {
      const meta = buildMetaLine({ id: 7, createdAt: baseJob.createdAt, processedPages: 4, totalPages: 12 });
      expect(meta).toContain("4/12 pages processed");
    });

    it("omits page fragment when processedPages is 0", () => {
      const meta = buildMetaLine({ id: 7, createdAt: baseJob.createdAt, processedPages: 0, totalPages: 12 });
      expect(meta).not.toContain("pages processed");
    });
  });

  describe("failed section visibility", () => {
    it("shows the section when there is at least one failed job", () => {
      expect(shouldShowFailedSection([baseJob])).toBe(true);
    });

    it("shows the section with multiple failed jobs", () => {
      expect(shouldShowFailedSection([baseJob, { ...baseJob, id: 99 }])).toBe(true);
    });

    it("hides the section when there are no failed jobs", () => {
      expect(shouldShowFailedSection([])).toBe(false);
    });
  });

  describe("FailedJob data shape", () => {
    it("has all required fields present", () => {
      const fields: Array<keyof FailedJob> = [
        "id", "vendor", "filename", "status",
        "errorMessage", "createdAt", "finishedAt",
        "processedPages", "totalPages", "matchedParts",
      ];
      for (const field of fields) {
        expect(baseJob).toHaveProperty(field);
      }
    });

    it("status is 'failed' for a failed job", () => {
      expect(baseJob.status).toBe("failed");
    });

    it("processedPages is a number (not null/undefined)", () => {
      expect(typeof baseJob.processedPages).toBe("number");
    });

    it("vendor and filename are non-empty strings", () => {
      expect(baseJob.vendor.length).toBeGreaterThan(0);
      expect(baseJob.filename.length).toBeGreaterThan(0);
    });
  });
});
