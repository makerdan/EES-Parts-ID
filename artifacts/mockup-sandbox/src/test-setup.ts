import { vi, beforeEach } from "vitest";

beforeEach(() => {
  // Pre-populate the admin token so ZoneEditor skips the login modal.
  // Without this, the password <input> remains focused and keyboard-shortcut
  // handlers and active-element checks fail silently.
  // Tests that deliberately need the token absent (e.g. the 401 login-form
  // test) must call sessionStorage.removeItem("zoneEditorAdminToken") in
  // their own body — the next test's beforeEach will restore it.
  try {
    sessionStorage.setItem("zoneEditorAdminToken", "test-token");
  } catch {}

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ zones: [], unsortedCount: 0, uncoveredAisles: [] }),
    text: () => Promise.resolve(""),
  } as unknown as Response);
});
