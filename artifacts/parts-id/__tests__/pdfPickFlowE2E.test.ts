/**
 * @jest-environment jsdom
 *
 * End-to-end integration test: PDF pick → read → API upload.
 *
 * Three phases run against real code and the live API server:
 *
 *  Phase 1 — readPdfAsBytes (web File path)
 *    Uses real FileReader via jsdom. No mocks of the utility itself.
 *    Verifies that a File object picked by expo-document-picker is correctly
 *    read and validated before any upload attempt.
 *
 *  Phase 2 — POST /api/admin/catalog-pdf (real HTTP)
 *    Sends a minimal valid PDF to the running api-server. Checks auth
 *    enforcement, field validation, and job creation.
 *
 *  Phase 3 — GET /api/admin/catalog-pdf/:id/status (real HTTP)
 *    Polls the status endpoint for the job created in Phase 2, then
 *    cancels it to leave the DB clean.
 *
 * API phases require the api-server to be reachable on localhost:3001 AND
 * ADMIN_PASSWORD to be set. They are automatically skipped (not failed)
 * when either condition is missing, so CI stays green without the server.
 */

// ── Mocks (must be declared before imports) ───────────────────────────────────

// Override the react-native moduleNameMapper so readPdfAsBase64 sees
// Platform.OS = "web" and takes the FileReader path instead of native.
jest.mock("react-native", () => ({
  Platform: { OS: "web" },
}));

// expo-file-system/legacy is imported at module level but only used on native.
// Stub it so the import resolves without an error.
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///mock-cache/",
  EncodingType: { UTF8: "utf8", Base64: "base64" },
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 512 }),
  readAsStringAsync: jest.fn().mockResolvedValue(""),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import crypto from "crypto";
import {
  readPdfAsBytes,
  InvalidPdfError,
  EncryptedPdfError,
} from "../utils/readPdfAsBase64";

// ── Minimal valid PDF fixture ─────────────────────────────────────────────────
// Passes both client-side validatePdfBytes (%PDF- magic + no /Encrypt) and
// server-side validatePdf (same checks). Background pdftoppm will fail on this
// stub, but the API responds 200 before background processing starts — which
// is exactly what the test needs to verify.

const MINIMAL_PDF_TEXT =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
  "xref\n0 4\n" +
  "0000000000 65535 f \n" +
  "0000000009 00000 n \n" +
  "0000000058 00000 n \n" +
  "0000000115 00000 n \n" +
  "trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF";

const MINIMAL_PDF_BYTES = new Uint8Array(Buffer.from(MINIMAL_PDF_TEXT));

function makeFile(bytes: Uint8Array = MINIMAL_PDF_BYTES, name = "catalog.pdf"): File {
  return new File([bytes.buffer as ArrayBuffer], name, { type: "application/pdf" });
}

// ── Admin token signing (mirrors api-server signAdminToken exactly) ────────────

function signAdminToken(ts: number, secret: string): string {
  const payload = String(ts);
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

// ── API connectivity / auth setup ─────────────────────────────────────────────

const API_BASE = "http://localhost:3001/api";
let apiReachable = false;
let adminToken = "";

beforeAll(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${API_BASE}/healthz`, { signal: ctrl.signal });
    clearTimeout(t);
    apiReachable = r.ok;
  } catch {
    apiReachable = false;
  }

  const pw = process.env["ADMIN_PASSWORD"];
  if (pw) {
    adminToken = signAdminToken(Date.now(), pw);
  }

  if (!apiReachable) {
    console.log("  ℹ️  api-server not reachable on localhost:3001 — API phases will be skipped");
  } else if (!adminToken) {
    console.log("  ℹ️  ADMIN_PASSWORD not set — authenticated API phases will be skipped");
  }
}, 10_000);

// ── Suppress act() noise in jsdom ─────────────────────────────────────────────

beforeAll(() => {
  jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const msg = typeof args[0] === "string" ? args[0] : "";
    if (msg.includes("act(") || msg.includes("not wrapped")) return;
    console.warn(...args);
  });
});
afterAll(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 1 — readPdfAsBytes: web File path (real FileReader via jsdom)
// ══════════════════════════════════════════════════════════════════════════════

describe("Phase 1 — readPdfAsBytes: web FileReader path", () => {
  it("returns a Uint8Array with the PDF magic bytes at offset 0", async () => {
    const file = makeFile();
    const result = await readPdfAsBytes("blob:mock-uri", file);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(MINIMAL_PDF_BYTES.length);
    expect(String.fromCharCode(...Array.from(result.slice(0, 5)))).toBe("%PDF-");
  });

  it("is byte-for-byte identical to the original File contents", async () => {
    const file = makeFile();
    const result = await readPdfAsBytes("blob:mock-uri", file);

    expect(Array.from(result)).toEqual(Array.from(MINIMAL_PDF_BYTES));
  });

  it("reads a differently-named file with the same bytes correctly", async () => {
    const file = makeFile(MINIMAL_PDF_BYTES, "acme-parts-catalog-2026.pdf");
    const result = await readPdfAsBytes("blob:mock-uri-2", file);

    expect(result.length).toBe(MINIMAL_PDF_BYTES.length);
    expect(String.fromCharCode(...Array.from(result.slice(0, 5)))).toBe("%PDF-");
  });

  it("throws InvalidPdfError for a file whose bytes do not start with %PDF-", async () => {
    const notPdf = new Uint8Array(Buffer.from("This is a plain text file, not a PDF."));
    const file = makeFile(notPdf, "fake.pdf");

    await expect(readPdfAsBytes("blob:mock-uri", file)).rejects.toThrow(InvalidPdfError);
  });

  it("throws InvalidPdfError for a JPEG file masquerading as a PDF", async () => {
    // JPEG magic: FF D8 FF
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = makeFile(jpeg, "photo.pdf");

    await expect(readPdfAsBytes("blob:mock-uri", file)).rejects.toThrow(InvalidPdfError);
  });

  it("throws EncryptedPdfError when /Encrypt appears in the first 2 KB", async () => {
    const encrypted = new Uint8Array(Buffer.from(
      "%PDF-1.6\n/Encrypt <<\n  /Filter /Standard\n  /R 4\n>>\n%%EOF",
    ));
    const file = makeFile(encrypted, "locked.pdf");

    await expect(readPdfAsBytes("blob:mock-uri", file)).rejects.toThrow(EncryptedPdfError);
  });

  it("handles a large (~2 MB) PDF-like file without error", async () => {
    // Build 2 MB of zeros preceded by the %PDF- magic so validation passes.
    const big = new Uint8Array(2 * 1024 * 1024);
    const magic = new Uint8Array(Buffer.from("%PDF-1.4\n%%EOF"));
    big.set(magic, 0);
    const file = makeFile(big, "big-catalog.pdf");

    const result = await readPdfAsBytes("blob:big-uri", file);
    expect(result.length).toBe(big.length);
    expect(String.fromCharCode(...Array.from(result.slice(0, 5)))).toBe("%PDF-");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 2 — POST /api/admin/catalog-pdf (real HTTP to running api-server)
// ══════════════════════════════════════════════════════════════════════════════

describe("Phase 2 — API: POST /api/admin/catalog-pdf", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    if (!apiReachable) { return; }

    const pdfBase64 = Buffer.from(MINIMAL_PDF_BYTES).toString("base64");
    const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfBase64, vendor: "ACME" }),
    });

    expect(r.status).toBe(401);
  });

  it("returns 400 when pdfBase64 field is missing", async () => {
    if (!apiReachable || !adminToken) { return; }

    const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ vendor: "ACME" }),
    });

    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/pdfBase64/i);
  });

  it("returns 400 when vendor field is missing", async () => {
    if (!apiReachable || !adminToken) { return; }

    const pdfBase64 = Buffer.from(MINIMAL_PDF_BYTES).toString("base64");
    const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ pdfBase64 }),
    });

    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/vendor/i);
  });

  it("returns 400 when the base64 payload is not a valid PDF", async () => {
    if (!apiReachable || !adminToken) { return; }

    const fakeBase64 = Buffer.from("This is not a PDF file").toString("base64");
    const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ pdfBase64: fakeBase64, vendor: "ACME" }),
    });

    expect(r.status).toBe(400);
  });

  it("returns 200 with a jobId for a valid PDF upload", async () => {
    if (!apiReachable || !adminToken) {
      console.log("    ⚠️  skipped — api-server or ADMIN_PASSWORD unavailable");
      return;
    }

    const pdfBase64 = Buffer.from(MINIMAL_PDF_BYTES).toString("base64");
    const r = await fetch(`${API_BASE}/admin/catalog-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        pdfBase64,
        vendor: "TESTVENDORE2E",
        filename: "e2e-integration-test.pdf",
      }),
    });

    expect(r.status).toBe(200);
    const body = await r.json() as { jobId: string; message: string };
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);
    expect(body.message).toMatch(/job started/i);
    console.log(`    ✓ Job created: id=${body.jobId}`);

    // Store for Phase 3
    sharedJobId = body.jobId;
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Phase 3 — GET status + cancel (uses job from Phase 2)
// ══════════════════════════════════════════════════════════════════════════════

let sharedJobId: string | null = null;

describe("Phase 3 — status poll + cleanup", () => {
  it("returns 200 with a valid status for the created job", async () => {
    if (!apiReachable || !adminToken || !sharedJobId) {
      console.log("    ⚠️  skipped — no job to poll");
      return;
    }

    const r = await fetch(`${API_BASE}/admin/catalog-pdf/${sharedJobId}/status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(r.status).toBe(200);
    const body = await r.json() as { status: string; processedPages?: number; totalPages?: number };
    console.log(
      `    ✓ Poll: status=${body.status} ` +
      `pages=${body.processedPages ?? "?"}/${body.totalPages ?? "?"}`,
    );
    expect(["pending", "processing", "done", "failed", "cancelled"]).toContain(body.status);
  });

  it("cancels the test job to leave the DB clean", async () => {
    if (!apiReachable || !adminToken || !sharedJobId) { return; }

    const r = await fetch(`${API_BASE}/admin/catalog-pdf/${sharedJobId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    // 200 = cancelled successfully, 409 = already in terminal state — both OK
    expect([200, 409]).toContain(r.status);
    console.log(`    ✓ Cleanup: cancel job ${sharedJobId} → HTTP ${r.status}`);
  });
});
