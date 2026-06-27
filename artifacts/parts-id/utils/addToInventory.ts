/**
 * Extracted async logic for the "Add to Inventory" POST action in the
 * add-part modal of catalog-review.tsx.
 *
 * Separated so it can be unit-tested without mounting the full screen.
 */

import { BIN_FORMAT_HINT,isBinLocationValid } from "./binValidation";

export type CreatedPart = {
  id: number;
  vendor: string;
  catalog: string;
  description: string;
  binLocations: Array<string>;
};

export type AddToInventoryForm = {
  vendor: string;
  catalog: string;
  description: string;
  binLocation: string;
};

export type AddToInventoryDeps = {
  apiBase: string;
  authHeaders: Record<string, string>;
  addForm: AddToInventoryForm;
  catalogNumber: string | null;
  logoutAdmin: () => void;
  setAddingInProgress: (v: boolean) => void;
  setAddError: (v: string | null) => void;
  setDuplicateItem: (v: CreatedPart | null) => void;
  setAddedCatalogs: (fn: (prev: Set<string>) => Set<string>) => void;
  setAddedItem: (v: CreatedPart) => void;
  setAddModalPart: (v: null) => void;
};

/**
 * POSTs a new part to /inventory/add-part.
 *
 * On success:   adds the catalog number to addedCatalogs and either shows
 *               the created item or closes the modal.
 * On 409:       if the server returns an existingItem, surfaces the duplicate
 *               conflict; otherwise shows the server error message.
 * On other API error: populates addError with the server message.
 * On network failure: populates addError with a generic message.
 * On 401:       calls logoutAdmin() and returns early without touching other state.
 */
export async function performAddToInventory(
  deps: AddToInventoryDeps,
): Promise<void> {
  const {
    apiBase,
    authHeaders,
    addForm,
    catalogNumber,
    logoutAdmin,
    setAddingInProgress,
    setAddError,
    setDuplicateItem,
    setAddedCatalogs,
    setAddedItem,
    setAddModalPart,
  } = deps;

  if (!addForm.vendor.trim()) {
    setAddError("Vendor is required.");
    return;
  }

  if (!isBinLocationValid(addForm.binLocation)) {
    setAddError(`Invalid bin location. ${BIN_FORMAT_HINT}`);
    return;
  }

  setAddingInProgress(true);
  setAddError(null);
  try {
    const r = await fetch(`${apiBase}/inventory/add-part`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        vendor: addForm.vendor.trim(),
        catalog: addForm.catalog.trim(),
        description: addForm.description.trim(),
        ...(addForm.binLocation.trim() ? { binLocation: addForm.binLocation.trim() } : {}),
      }),
    });
    if (r.status === 401) {
      logoutAdmin();
      return;
    }
    if (r.status === 409) {
      const body = await r.json().catch(() => ({})) as { error?: string; existingItem?: CreatedPart };
      if (body.existingItem) {
        setDuplicateItem(body.existingItem);
      } else {
        setAddError(body.error ?? "This part already exists in inventory.");
      }
      return;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setAddError(body.error ?? "Failed to add part.");
      return;
    }
    const body = await r.json().catch(() => ({})) as { item?: CreatedPart };
    if (catalogNumber !== null) {
      setAddedCatalogs((prev) => new Set([...prev, catalogNumber]));
    }
    if (body.item) {
      setAddedItem(body.item);
    } else {
      setAddModalPart(null);
    }
  } catch {
    setAddError("Network error. Please try again.");
  } finally {
    setAddingInProgress(false);
  }
}
