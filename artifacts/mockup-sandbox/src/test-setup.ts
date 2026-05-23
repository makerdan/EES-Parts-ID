import { vi, beforeEach } from "vitest";

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ zones: [], unsortedCount: 0, uncoveredAisles: [] }),
    text: () => Promise.resolve(""),
  } as unknown as Response);
});
