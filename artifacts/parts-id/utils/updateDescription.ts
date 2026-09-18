/**
 * Extracted async logic for the "Update description" PATCH action in the
 * conflict modal of catalog-review.tsx.
 *
 * Separated so it can be unit-tested without mounting the full screen.
 */

export type UpdateDescriptionDeps = {
  apiBase: string;
  authHeaders: Record<string, string>;
  duplicateItemId: number;
  description: string;
  catalogNumber: string | null;
  logoutAdmin: () => void;
  setUpdatingDescription: (v: boolean) => void;
  setUpdateDescriptionError: (v: string | null) => void;
  setAddedCatalogs: (fn: (prev: Set<string>) => Set<string>) => void;
  setAddModalPart: (v: null) => void;
  setDuplicateItem: (v: null) => void;
};

/**
 * PATCHes the description for a duplicate inventory item.
 *
 * On success: adds the catalog number to addedCatalogs and closes the modal.
 * On API error: populates updateDescriptionError with the server message.
 * On network failure: populates updateDescriptionError with a generic message.
 * On 401: calls logoutAdmin() and returns early without touching other state.
 */
export async function performUpdateDescription(
  deps: UpdateDescriptionDeps,
): Promise<void> {
  const {
    apiBase,
    authHeaders,
    duplicateItemId,
    description,
    catalogNumber,
    logoutAdmin,
    setUpdatingDescription,
    setUpdateDescriptionError,
    setAddedCatalogs,
    setAddModalPart,
    setDuplicateItem,
  } = deps;

  setUpdatingDescription(true);
  setUpdateDescriptionError(null);
  try {
    const r = await fetch(`${apiBase}/admin/inventory/${duplicateItemId}/description`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    if (r.status === 401) {
      logoutAdmin();
      return;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setUpdateDescriptionError(body.error ?? "Failed to update description.");
      return;
    }
    if (catalogNumber !== null) {
      setAddedCatalogs((prev) => new Set([...prev, catalogNumber]));
    }
    setAddModalPart(null);
    setDuplicateItem(null);
  } catch {
    setUpdateDescriptionError("Network error. Please try again.");
  } finally {
    setUpdatingDescription(false);
  }
}
