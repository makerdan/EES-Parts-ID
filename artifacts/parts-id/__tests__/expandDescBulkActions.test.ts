/**
 * @jest-environment node
 *
 * Guards the bulk Save All / Discard All handlers in the Expand Descriptions
 * enrichment flow:
 *
 *  - Discard All marks every "pending" result "discarded" without any API calls.
 *  - Save All PATCHes /inventory/:id/expanded-description for each pending result
 *    in sequence and marks them "saved".
 *  - Neither handler does any work when expandDescRunning is true.
 */

import { applyDiscardAll, runSaveAll } from "../utils/expandDescHandlers";
import type { ExpandDescResult } from "../utils/expandDescHandlers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(
  overrides: Partial<ExpandDescResult> & Pick<ExpandDescResult, "id">,
): ExpandDescResult {
  return {
    partNumber: `PART-${overrides.id}`,
    originalDescription: "Original desc",
    expandedDescription: "Expanded desc",
    editedText: "Expanded desc",
    savedStatus: "pending",
    ...overrides,
  };
}

function mockOkFetch(): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true } as Response);
}

// ── applyDiscardAll ───────────────────────────────────────────────────────────

describe("applyDiscardAll", () => {
  it("sets all pending results to discarded", () => {
    const results: ExpandDescResult[] = [
      makeResult({ id: 1, savedStatus: "pending" }),
      makeResult({ id: 2, savedStatus: "pending" }),
      makeResult({ id: 3, savedStatus: "saved" }),
    ];

    const next = applyDiscardAll(results, false);

    expect(next[0]!.savedStatus).toBe("discarded");
    expect(next[1]!.savedStatus).toBe("discarded");
    expect(next[2]!.savedStatus).toBe("saved"); // already saved — untouched
  });

  it("leaves non-pending entries (saved, discarded, saving) unchanged", () => {
    const results: ExpandDescResult[] = [
      makeResult({ id: 1, savedStatus: "saved" }),
      makeResult({ id: 2, savedStatus: "discarded" }),
      makeResult({ id: 3, savedStatus: "saving" }),
    ];

    const next = applyDiscardAll(results, false);

    // Each entry keeps exactly the status it had before the call
    expect(next[0]!.savedStatus).toBe("saved");
    expect(next[1]!.savedStatus).toBe("discarded");
    expect(next[2]!.savedStatus).toBe("saving");
  });

  it("is a no-op (returns same reference) when isRunning is true", () => {
    const results: ExpandDescResult[] = [
      makeResult({ id: 1, savedStatus: "pending" }),
    ];

    const next = applyDiscardAll(results, true);

    expect(next).toBe(results); // exact same reference — nothing mutated
    expect(next[0]!.savedStatus).toBe("pending");
  });
});

// ── runSaveAll ────────────────────────────────────────────────────────────────

describe("runSaveAll", () => {
  const API_BASE = "/api";
  const ADMIN_HEADERS = { Authorization: "Bearer test-token" };

  it("PATCHes each pending result in sequence and marks them saved", async () => {
    const fetchFn = mockOkFetch();
    const updates: Array<{ id: number; status: ExpandDescResult["savedStatus"] }> = [];
    const onUpdate = (id: number, status: ExpandDescResult["savedStatus"]) => {
      updates.push({ id, status });
    };

    const results: ExpandDescResult[] = [
      makeResult({ id: 10, savedStatus: "pending", editedText: "Desc A" }),
      makeResult({ id: 11, savedStatus: "pending", editedText: "Desc B" }),
    ];

    await runSaveAll(results, false, onUpdate, API_BASE, ADMIN_HEADERS, fetchFn);

    // fetch called once per pending result
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "/api/inventory/10/expanded-description",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "/api/inventory/11/expanded-description",
      expect.objectContaining({ method: "PATCH" }),
    );

    // each result: saving → saved
    expect(updates).toEqual([
      { id: 10, status: "saving" },
      { id: 10, status: "saved" },
      { id: 11, status: "saving" },
      { id: 11, status: "saved" },
    ]);
  });

  it("skips results that are not pending", async () => {
    const fetchFn = mockOkFetch();
    const onUpdate = jest.fn();

    const results: ExpandDescResult[] = [
      makeResult({ id: 20, savedStatus: "saved" }),
      makeResult({ id: 21, savedStatus: "discarded" }),
      makeResult({ id: 22, savedStatus: "saving" }),
    ];

    await runSaveAll(results, false, onUpdate, API_BASE, ADMIN_HEADERS, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("skips pending results that have an error flag", async () => {
    const fetchFn = mockOkFetch();
    const onUpdate = jest.fn();

    const results: ExpandDescResult[] = [
      makeResult({ id: 30, savedStatus: "pending", error: "AI failed" }),
    ];

    await runSaveAll(results, false, onUpdate, API_BASE, ADMIN_HEADERS, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("marks a result as error when the PATCH request fails", async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const updates: Array<{ id: number; status: ExpandDescResult["savedStatus"] }> = [];

    const results: ExpandDescResult[] = [
      makeResult({ id: 40, savedStatus: "pending", editedText: "Desc" }),
    ];

    await runSaveAll(
      results,
      false,
      (id, status) => updates.push({ id, status }),
      API_BASE,
      ADMIN_HEADERS,
      fetchFn,
    );

    expect(updates).toEqual([
      { id: 40, status: "saving" },
      { id: 40, status: "error" }, // surface the failure, not a silent rollback
    ]);
  });

  it("marks a result as error when the fetch itself throws (network failure)", async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error("Network error"));
    const updates: Array<{ id: number; status: ExpandDescResult["savedStatus"] }> = [];

    const results: ExpandDescResult[] = [
      makeResult({ id: 41, savedStatus: "pending", editedText: "Desc" }),
    ];

    await runSaveAll(
      results,
      false,
      (id, status) => updates.push({ id, status }),
      API_BASE,
      ADMIN_HEADERS,
      fetchFn,
    );

    expect(updates).toEqual([
      { id: 41, status: "saving" },
      { id: 41, status: "error" },
    ]);
  });

  it("is a no-op and makes no fetch calls when isRunning is true", async () => {
    const fetchFn = mockOkFetch();
    const onUpdate = jest.fn();

    const results: ExpandDescResult[] = [
      makeResult({ id: 50, savedStatus: "pending", editedText: "Desc" }),
    ];

    await runSaveAll(results, true, onUpdate, API_BASE, ADMIN_HEADERS, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
