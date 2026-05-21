/**
 * Display utilities for the failed PDF job card rendered in catalog-review.tsx.
 *
 * Extracted so they can be unit-tested independently of the React Native
 * rendering infrastructure, ensuring regressions to card text or logic are
 * caught without a full component render.
 */

export interface FailedJobLike {
  id: number;
  createdAt: string;
  processedPages: number;
  totalPages: number | null;
  errorMessage: string | null;
}

/**
 * The exact instruction text shown below each failed job card.
 * Exported so tests can assert the precise wording without duplicating it.
 */
export const FAILED_JOB_RESUBMIT_TEXT =
  'To resubmit: go to the Upload tab, enter the vendor name, select the same PDF, and tap "Start Extraction".';

/**
 * Returns the error message to display for a failed job.
 * Falls back to "Unknown error" only when the message is null or undefined.
 * An empty string is considered a valid (blank) message and is returned as-is.
 */
export function displayErrorMessage(job: Pick<FailedJobLike, "errorMessage">): string {
  return job.errorMessage ?? "Unknown error";
}

/**
 * Builds the page-progress fragment appended to the job meta line.
 *   processedPages=0        → ""
 *   processedPages=3, total=10 → " · 3/10 pages processed"
 *   processedPages=5, total=null → " · 5 pages processed"
 */
export function buildPageProgressFragment(
  job: Pick<FailedJobLike, "processedPages" | "totalPages">,
): string {
  if (job.processedPages <= 0) return "";
  const total = job.totalPages ? `/${job.totalPages}` : "";
  return ` · ${job.processedPages}${total} pages processed`;
}

/**
 * Builds the full meta line shown below a failed job card:
 *   "Job #<id> · <locale date>[page fragment]"
 */
export function buildFailedJobMetaLine(
  job: Pick<FailedJobLike, "id" | "createdAt" | "processedPages" | "totalPages">,
): string {
  const dateStr = new Date(job.createdAt).toLocaleDateString();
  return `Job #${job.id} · ${dateStr}${buildPageProgressFragment(job)}`;
}
