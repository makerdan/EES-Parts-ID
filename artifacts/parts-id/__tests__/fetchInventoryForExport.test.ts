import type { InventoryItem } from "@workspace/api-client-react";

import { fetchInventoryForExport } from "../utils/fetchInventoryForExport";

function fakeInventory(ids: number[]) {
  const rows = ids.map(id => ({ id } as InventoryItem));
  const calls: URL[] = [];
  const request = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url);
    const afterId = Number(url.searchParams.get("after_id"));
    const throughId = url.searchParams.has("through_id")
      ? Number(url.searchParams.get("through_id")) : Math.max(0, ...ids);
    const page = rows.filter(row => row.id > afterId && row.id <= throughId).slice(0, 500);
    return {
      ok: true,
      json: async () => ({ items: page, total: rows.length, throughId }),
    } as Response;
  });
  return { request: request as unknown as typeof fetch, calls };
}

describe("inventory export continuation", () => {
  it("crosses 10,000 entries once each without asking for an offset", async () => {
    const ids = Array.from({ length: 10_003 }, (_, i) => i + 1);
    const { request, calls } = fakeInventory(ids);
    const items = await fetchInventoryForExport("/api", {}, request);
    expect(items.map(item => item.id)).toEqual(ids);
    expect(calls.length).toBe(21);
    expect(calls.every(url => !url.searchParams.has("page"))).toBe(true);
    expect(calls[20]!.searchParams.get("after_id")).toBe("10000");
    expect(calls[20]!.searchParams.get("through_id")).toBe("10003");
  });

  it("returns an empty inventory without requesting another page", async () => {
    const { request, calls } = fakeInventory([]);
    expect(await fetchInventoryForExport("/api", {}, request)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rejects repeating rows rather than silently exporting duplicates", async () => {
    const request = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ id: 1 }, { id: 1 }], total: 2, throughId: 2 }),
    })) as unknown as typeof fetch;
    await expect(fetchInventoryForExport("/api", {}, request))
      .rejects.toThrow("invalid inventory continuation");
  });
});