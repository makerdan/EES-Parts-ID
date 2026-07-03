import { vi, beforeEach } from "vitest";

beforeEach(() => {
  // Admin auth is handled by <AdminGate> in App.tsx (Clerk session), so ZoneEditor
  // itself no longer renders a login modal — it assumes it only mounts for an
  // authenticated admin. Tests can render <ZoneEditor /> directly.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ zones: [], unsortedCount: 0, uncoveredAisles: [] }),
    text: () => Promise.resolve(""),
  } as unknown as Response);
});
