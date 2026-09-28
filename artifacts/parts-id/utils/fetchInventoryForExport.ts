import type { InventoryItem } from "@workspace/api-client-react";

/** Read the id-ordered, high-water-bounded export stream without using deep offsets. */
export async function fetchInventoryForExport(
  apiBase: string,
  headers: Record<string, string>,
  request: typeof fetch = fetch,
): Promise<Array<InventoryItem>> {
  const pageSize = 500;
  const items: Array<InventoryItem> = [];
  let afterId = 0;
  let throughId: number | undefined;
  let maxPages: number | undefined;
  let pagesFetched = 0;

  while (true) {
    if (maxPages !== undefined && pagesFetched >= maxPages) {
      throw new Error("Export aborted — unexpected server response. Please try again.");
    }
    const params = new URLSearchParams({ after_id: String(afterId), limit: String(pageSize) });
    if (throughId !== undefined) params.set("through_id", String(throughId));
    const response = await request(`${apiBase}/inventory?${params}`, { headers });
    if (!response.ok) throw new Error(`API error ${response.status}`);
    const data: { items: Array<InventoryItem>; total: number; throughId?: number } = await response.json();
    if (!Array.isArray(data.items) || data.items.length > pageSize ||
        !Number.isSafeInteger(data.throughId) || data.throughId! < 0 ||
        (throughId !== undefined && data.throughId !== throughId) ||
        (throughId === undefined && (!Number.isSafeInteger(data.total) || data.total < 0))) {
      throw new Error("Export aborted — invalid server response.");
    }
    if (throughId === undefined) {
      throughId = data.throughId;
      maxPages = Math.ceil(data.total / pageSize) + 2;
    }
    for (const item of data.items) {
      if (!Number.isSafeInteger(item.id) || item.id <= afterId || item.id > throughId!) {
        throw new Error("Export aborted — invalid inventory continuation.");
      }
      afterId = item.id;
      items.push(item);
    }
    pagesFetched++;
    if (data.items.length < pageSize) return items;
  }
}