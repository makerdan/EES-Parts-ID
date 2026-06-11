/**
 * Pure/injectable logic for the bulk Save All / Discard All actions in the
 * Expand Descriptions enrichment flow.  Extracted from upload.tsx so the
 * handlers can be unit-tested without mounting the full screen component.
 */

export type ExpandDescResult = {
  id: number;
  partNumber: string;
  originalDescription: string;
  expandedDescription: string | null;
  editedText: string;
  savedStatus: "pending" | "saving" | "saved" | "discarded";
  error?: string;
};

/**
 * Returns a new results array with every "pending" entry flipped to
 * "discarded".  No-ops (returns the original array reference) when
 * `isRunning` is true so the guard is testable.
 */
export function applyDiscardAll(
  results: ExpandDescResult[],
  isRunning: boolean,
): ExpandDescResult[] {
  if (isRunning) return results;
  return results.map(r =>
    r.savedStatus === "pending" ? { ...r, savedStatus: "discarded" as const } : r,
  );
}

/**
 * Iterates over every "pending" result (with non-empty editedText and no
 * error) and PATCHes the API in sequence.  Resolves without doing anything
 * when `isRunning` is true.
 *
 * `onUpdate` is called with the result id and the new status so the caller
 * can apply the change to React state in whatever way it likes.
 *
 * `fetchFn` is injectable for testing (defaults to the global fetch when
 * called from the component).
 */
export async function runSaveAll(
  results: ExpandDescResult[],
  isRunning: boolean,
  onUpdate: (id: number, status: ExpandDescResult["savedStatus"]) => void,
  apiBase: string,
  adminHeaders: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (isRunning) return;
  const pending = results.filter(
    r => r.savedStatus === "pending" && !r.error && r.editedText.trim(),
  );
  for (const result of pending) {
    onUpdate(result.id, "saving");
    try {
      const res = await fetchFn(
        `${apiBase}/inventory/${result.id}/expanded-description`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...adminHeaders },
          body: JSON.stringify({
            expandedDescription: result.editedText.trim() || null,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onUpdate(result.id, "saved");
    } catch {
      onUpdate(result.id, "pending");
    }
  }
}
