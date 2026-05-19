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
import { promisify } from "util";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);

export interface PageData {
  pageNum: number;
  text: string;
  /**
   * PNG Buffers for this page.
   * Primary: [rendered full-page PNG]
   * Fallback: embedded raster images found on the page
   */
  images: Buffer[];
  /** True when images[0] is a full rendered page image (not extracted objects) */
  isRendered: boolean;
  /** Pixel dimensions of the rendered page image (only set when isRendered=true) */
  pageWidth: number;
  pageHeight: number;
}

/** DPI to use when rendering pages. 150 dpi gives ~1240×1754 for A4. */
const RENDER_DPI = 150;

/**
 * Process a PDF buffer and return per-page data ready for GPT-4o extraction.
 */
export async function extractPdfPages(pdfBuffer: Buffer): Promise<PageData[]> {
  // Try pdftoppm rendering first (best quality, full page context for GPT-4o)
  const rendered = await tryPdftoppmRendering(pdfBuffer);
  if (rendered) return rendered;

  // Fallback: pdfjs-dist text + embedded image extraction
  return pdfJsFallback(pdfBuffer);
}

// ── pdftoppm rendering (primary path) ────────────────────────────────────────

async function tryPdftoppmRendering(pdfBuffer: Buffer): Promise<PageData[] | null> {
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

    // Get page text via pdfjs-dist for supplementary context
    const textByPage = await extractTextOnly(pdfBuffer, pngFiles.length);

    const pages: PageData[] = await Promise.all(
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

/** Extract text content only from all pages via pdfjs-dist. */
async function extractTextOnly(pdfBuffer: Buffer, numPages: number): Promise<string[]> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "";
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      useSystemFonts: true,
      disableRange: true,
      disableStream: true,
    }).promise;

    const results: string[] = [];
    for (let p = 1; p <= Math.min(numPages, doc.numPages); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = (tc.items as Array<{ str?: string }>)
        .map((i) => i.str ?? "")
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
      results.push(text);
      page.cleanup();
    }
    return results;
  } catch {
    return Array(numPages).fill("") as string[];
  }
}

// ── pdfjs-dist fallback (text + embedded images) ─────────────────────────────

async function pdfJsFallback(pdfBuffer: Buffer): Promise<PageData[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "";

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
  const pages: PageData[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    let text = "";
    const images: Buffer[] = [];

    try {
      const tc = await page.getTextContent();
      text = (tc.items as Array<{ str?: string }>)
        .map((i) => i.str ?? "")
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
    } catch { /* non-fatal */ }

    if (sharpFn) {
      try {
        const ops = await page.getOperatorList();
        const seenKeys = new Set<string>();
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (
            ops.fnArray[i] === pdfjs.OPS.paintImageXObject ||
            ops.fnArray[i] === pdfjs.OPS.paintInlineImageXObject
          ) {
            const imgKey: string = (ops.argsArray[i] as string[])?.[0] ?? "";
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
