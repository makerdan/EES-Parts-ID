/**
 * PDF processing utility.
 *
 * Renders each PDF page to a PNG image using pdftoppm (poppler, available on
 * the Replit NixOS runtime) then returns an ordered array of page data.
 * The rendered page image is the primary input to GPT-4o vision analysis.
 *
 * Fallback: if pdftoppm is unavailable, extracts raw text + embedded raster
 * images from each page via pdfjs-dist.
 */

import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { logger } from "../lib/logger";

const execFileAsync = promisify(execFile);

export interface PageData {
  pageNum: number;
  text: string;
  /**
   * PNG Buffers for this page.
   * Primary: [rendered full-page PNG]
   * Fallback: embedded raster images found on the page
   */
  images: Array<Buffer>;
  /** True when images[0] is a full rendered page image (not extracted objects) */
  isRendered: boolean;
  /** Pixel dimensions of the rendered page image (only set when isRendered=true) */
  pageWidth: number;
  pageHeight: number;
}

/** DPI to use when rendering pages. 150 dpi gives ~1240×1754 for A4. */
const RENDER_DPI = 150;

/**
 * Lightweight synchronous pre-validation of a PDF buffer.
 * Checks PDF magic bytes and detects encrypted PDFs without spawning any
 * processes or loading pdfjs-dist. This runs on the HTTP request thread so
 * it must complete in microseconds — full page rendering happens in the
 * background task via extractPdfPages.
 * Throws with a descriptive message if the PDF is invalid.
 */
export function validatePdf(pdfBuffer: Buffer): void {
  if (pdfBuffer.length < 5 || pdfBuffer.slice(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Not a valid PDF file (missing %PDF- magic bytes)");
  }
  // Scan the first 64 KB for the /Encrypt entry present in all standard
  // PDF encryption dictionaries. This detects password-protected PDFs
  // before any heavy rendering begins.
  const scanEnd = Math.min(pdfBuffer.length, 65_536);
  const header = pdfBuffer.slice(0, scanEnd).toString("latin1");
  if (/\/Encrypt\b/.test(header)) {
    throw new Error("Encrypted PDF: cannot process password-protected PDFs");
  }
}

/**
 * Process a PDF buffer and return per-page data ready for GPT-4o extraction.
 */
export async function extractPdfPages(pdfBuffer: Buffer): Promise<Array<PageData>> {
  // Try pdftoppm rendering first (best quality, full page context for GPT-4o)
  const rendered = await tryPdftoppmRendering(pdfBuffer);
  if (rendered) return rendered;

  // Fallback: pdfjs-dist text + embedded image extraction
  return pdfJsFallback(pdfBuffer);
}

// ── Text reconstruction ────────────────────────────────────────────────────────

interface RawItem {
  str?: string;
  transform?: Array<number>;
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
}

/**
 * Reconstruct page text preserving reading order and table structure.
 * Groups items by Y coordinate (±4 pt tolerance), sorts buckets top-to-bottom,
 * items within each bucket left-to-right, then joins with tabs (columns) and
 * newlines (rows). This keeps table rows intact instead of turning them into
 * word soup.
 */
function reconstructText(items: Array<RawItem>): string {
  const positioned: Array<PositionedItem> = items
    .map((i) => ({ str: i.str ?? "", x: i.transform?.[4] ?? 0, y: i.transform?.[5] ?? 0 }))
    .filter((i) => i.str.trim().length > 0);

  if (positioned.length === 0) return "";

  const buckets: Array<Array<PositionedItem>> = [];
  for (const item of positioned) {
    const existing = buckets.find((b) => Math.abs(b[0].y - item.y) <= 4);
    if (existing) {
      existing.push(item);
    } else {
      buckets.push([item]);
    }
  }

  // Sort buckets top-to-bottom (PDF y=0 is bottom, so higher y = higher on page)
  buckets.sort((a, b) => b[0].y - a[0].y);

  for (const bucket of buckets) {
    bucket.sort((a, b) => a.x - b.x);
  }

  return buckets
    .map((bucket) => bucket.map((i) => i.str).join("\t"))
    .join("\n")
    .trim();
}

// ── Structure tree helpers ─────────────────────────────────────────────────────

interface StructFigure {
  alt: string | null;
  bbox: Array<number> | null;
}

interface StructNode {
  role?: string;
  type?: string;
  alt?: string;
  bbox?: Array<number>;
  children?: Array<unknown>;
}

/** Walk the pdfjs structure tree recursively and collect Figure nodes. */
function collectFigures(node: unknown, out: Array<StructFigure>): void {
  if (!node || typeof node !== "object") return;
  const n = node as StructNode;
  if (n.role === "Figure") {
    out.push({ alt: n.alt ?? null, bbox: n.bbox ?? null });
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      collectFigures(child, out);
    }
  }
}

/**
 * Build the contextual text block for one page:
 * 1. Reconstructed reading-order text (tab-separated columns)
 * 2. Image alt text lines from tagged PDF structure tree
 * 3. Caption lines: text items spatially just below each figure bbox
 */
function buildPageContext(
  items: Array<RawItem>,
  figures: Array<StructFigure>,
): string {
  const baseText = reconstructText(items);

  // Deduplicated alt text lines
  const altLines: Array<string> = [];
  const seenAlts = new Set<string>();
  for (const fig of figures) {
    if (fig.alt && fig.alt.trim()) {
      const trimmed = fig.alt.trim();
      if (!seenAlts.has(trimmed)) {
        seenAlts.add(trimmed);
        altLines.push(`Image alt: ${trimmed}`);
      }
    }
  }

  // Spatial caption extraction: text items whose baseline Y falls just below
  // each figure's bottom edge (within 40 pts below the figure).
  // PDF coordinate system: y increases upward, so figure bottom = bbox[1] (y_min).
  const captionLines: Array<string> = [];
  const positioned: Array<PositionedItem> = items
    .map((i) => ({ str: i.str ?? "", x: i.transform?.[4] ?? 0, y: i.transform?.[5] ?? 0 }))
    .filter((i) => i.str.trim().length > 0);

  for (const fig of figures) {
    if (!fig.bbox || fig.bbox.length < 4) continue;
    const figBottom = fig.bbox[1]; // y_min (bottom of figure in PDF space)
    const captionBand = figBottom - 40;

    const below = positioned
      .filter((i) => i.y < figBottom && i.y >= captionBand)
      .sort((a, b) => a.x - b.x);

    if (below.length > 0) {
      const captionText = below.map((i) => i.str).join(" ").trim();
      if (captionText) {
        captionLines.push(`Caption: ${captionText}`);
      }
    }
  }

  const extras = [...altLines, ...captionLines];
  if (extras.length === 0) return baseText;
  return extras.join("\n") + (baseText ? "\n" + baseText : "");
}

// ── pdftoppm rendering (primary path) ────────────────────────────────────────

async function tryPdftoppmRendering(pdfBuffer: Buffer): Promise<Array<PageData> | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-pdf-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");

  try {
    await fs.writeFile(pdfPath, pdfBuffer);

    try {
      await execFileAsync("pdftoppm", ["-png", "-r", String(RENDER_DPI), pdfPath, outPrefix], {
        timeout: 120_000,
      });
    } catch {
      return null; // pdftoppm not available or failed
    }

    // Read rendered page PNGs (pdftoppm names them: page-1.png, page-2.png …)
    const dirEntries = await fs.readdir(tmpDir);
    const pngFiles = dirEntries
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort((a, b) => {
        const na = parseInt(a.replace(/\D/g, ""), 10);
        const nb = parseInt(b.replace(/\D/g, ""), 10);
        return na - nb;
      });

    if (pngFiles.length === 0) return null;

    // Get page text + alt text + captions via pdfjs-dist for supplementary context
    const textByPage = await extractRichText(pdfBuffer, pngFiles.length);

    const pages: Array<PageData> = await Promise.all(
      pngFiles.map(async (fname, i) => {
        const imgBuf = await fs.readFile(path.join(tmpDir, fname));
        // Get dimensions from PNG header (bytes 16–24)
        const pageWidth = imgBuf.readUInt32BE(16);
        const pageHeight = imgBuf.readUInt32BE(20);
        return {
          pageNum: i + 1,
          text: textByPage[i] ?? "",
          images: [imgBuf],
          isRendered: true,
          pageWidth,
          pageHeight,
        };
      }),
    );

    return pages;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => null);
  }
}

/**
 * Extract rich text context for all pages: reconstructed reading-order text,
 * structure tree alt text, and spatial captions.
 */
/** @internal exported for unit testing only */
export async function extractRichText(pdfBuffer: Buffer, numPages: number): Promise<Array<string>> {
  try {
    stubMissingDomGlobals();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "";
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      useSystemFonts: true,
      disableRange: true,
      disableStream: true,
    }).promise;

    const pageCount = Math.min(numPages, doc.numPages);

    // Pre-fetch all structure trees concurrently to avoid one sequential
    // round-trip per page inside the loop below.
    const structTreeCache = new Map<number, unknown>();
    await Promise.all(
      Array.from({ length: pageCount }, async (_, i) => {
        const p = i + 1;
        try {
          const pg = await doc.getPage(p);
          const tree = await (pg as unknown as { getStructTree(): Promise<unknown> }).getStructTree();
          structTreeCache.set(p, tree);
        } catch { /* structure tree unavailable — non-fatal */ }
      }),
    );

    const results: Array<string> = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items as Array<RawItem>;

      // Use the pre-fetched structure tree from cache.
      const figures: Array<StructFigure> = [];
      const cachedTree = structTreeCache.get(p);
      if (cachedTree !== undefined) {
        collectFigures(cachedTree, figures);
      }

      results.push(buildPageContext(items, figures));
      page.cleanup();
    }
    return results;
  } catch (err) {
    logger.warn(
      { err },
      "extractRichText failed — returning empty text fallback",
    );
    return Array(numPages).fill("") as Array<string>;
  }
}

// ── pdfjs-dist fallback (text + embedded images) ─────────────────────────────

/**
 * Stub minimal browser globals that pdfjs-dist/legacy reads at module-init time
 * (inside its canvas.js __init). Without these stubs, importing pdfjs in a
 * plain Node.js environment throws `ReferenceError: DOMMatrix is not defined`
 * even when no canvas rendering is ever requested.  The stubs are no-ops — they
 * are never called during pure text extraction.
 */
function stubMissingDomGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g["DOMMatrix"] === "undefined") {
    g["DOMMatrix"] = class DOMMatrix { constructor() { /* no-op */ } };
  }
  if (typeof g["ImageData"] === "undefined") {
    g["ImageData"] = class ImageData { constructor() { /* no-op */ } };
  }
  if (typeof g["Path2D"] === "undefined") {
    g["Path2D"] = class Path2D { constructor() { /* no-op */ } };
  }
}

async function pdfJsFallback(pdfBuffer: Buffer): Promise<Array<PageData>> {
  stubMissingDomGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "";

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    useSystemFonts: true,
    disableRange: true,
    disableStream: true,
  }).promise;

  let sharpFn: ((data: Buffer, opts: object) => { png: () => { toBuffer: () => Promise<Buffer> } }) | null = null;
  try {
    const sharpMod = await import("sharp");
    sharpFn = (sharpMod.default ?? sharpMod) as unknown as typeof sharpFn;
  } catch { /* images skipped */ }

  const numPages: number = doc.numPages;

  // Pre-fetch all structure trees concurrently to avoid one sequential
  // round-trip per page inside the loop below.
  const structTreeCache = new Map<number, unknown>();
  await Promise.all(
    Array.from({ length: numPages }, async (_, i) => {
      const p = i + 1;
      try {
        const pg = await doc.getPage(p);
        const tree = await (pg as unknown as { getStructTree(): Promise<unknown> }).getStructTree();
        structTreeCache.set(p, tree);
      } catch { /* non-fatal */ }
    }),
  );

  const pages: Array<PageData> = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    let text = "";
    const images: Array<Buffer> = [];

    try {
      const tc = await page.getTextContent();
      const items = tc.items as Array<RawItem>;

      // Use the pre-fetched structure tree from cache.
      const figures: Array<StructFigure> = [];
      const cachedTree = structTreeCache.get(pageNum);
      if (cachedTree !== undefined) {
        collectFigures(cachedTree, figures);
      }

      text = buildPageContext(items, figures);
    } catch (err) {
      logger.warn({ err, pageNum }, "pdfJsFallback: getTextContent failed for page — text will be empty");
    }

    if (sharpFn) {
      try {
        const ops = await page.getOperatorList();
        const seenKeys = new Set<string>();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (
            ops.fnArray[i] === pdfjs.OPS.paintImageXObject ||
            ops.fnArray[i] === pdfjs.OPS.paintInlineImageXObject
          ) {
            const imgKey: string = (ops.argsArray[i] as Array<string>)?.[0] ?? "";
            if (!imgKey || seenKeys.has(imgKey)) continue;
            seenKeys.add(imgKey);
            try {
              const imgData = await new Promise<{ data: Uint8ClampedArray; width: number; height: number } | null>(
                (resolve) => {
                  try {
                    page.objs.get(imgKey, (data: unknown) => {
                      resolve(data as { data: Uint8ClampedArray; width: number; height: number } | null);
                    });
                  } catch { resolve(null); }
                },
              );
              if (imgData && imgData.data && imgData.width >= 20 && imgData.height >= 20) {
                const raw = Buffer.from(imgData.data.buffer);
                const ch = raw.length / (imgData.width * imgData.height);
                if (ch === 3 || ch === 4) {
                  const png = await sharpFn(raw, {
                    raw: { width: imgData.width, height: imgData.height, channels: ch as 3 | 4 },
                  }).png().toBuffer();
                  images.push(png);
                }
              }
            } catch { /* per-image failure non-fatal */ }
          }
        }
      } catch { /* operator list failure non-fatal */ }
    }

    pages.push({ pageNum, text, images, isRendered: false, pageWidth: 0, pageHeight: 0 });
    page.cleanup();
  }

  return pages;
}
