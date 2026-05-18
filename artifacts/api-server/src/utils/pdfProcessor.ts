/**
 * PDF processing utility.
 * Extracts per-page text content and embedded raster images from a PDF buffer
 * using pdfjs-dist v5 (no canvas rendering required — text and image object
 * extraction work entirely on the CPU without a DOM or canvas).
 */

export interface PageData {
  pageNum: number;
  text: string;
  /** PNG Buffers of embedded raster images found on this page */
  images: Buffer[];
}

/**
 * Process a PDF buffer and return per-page text + embedded images.
 * Images are returned as PNG buffers converted from raw RGBA via sharp.
 * On any per-page failure the page still returns with text only.
 */
export async function extractPdfPages(pdfBuffer: Buffer): Promise<PageData[]> {
  // Dynamic imports — both are ESM-only packages; tsx handles them at runtime.
  const pdfjs = await import("pdfjs-dist");

  // Disable the web worker — pdfjs v5 runs fine on the main thread in Node.js.
  pdfjs.GlobalWorkerOptions.workerSrc = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sharpFn: ((data: Buffer, opts: object) => { png: () => { toBuffer: () => Promise<Buffer> } }) | null = null;
  try {
    const sharpMod = await import("sharp");
    sharpFn = (sharpMod.default ?? sharpMod) as unknown as typeof sharpFn;
  } catch {
    // sharp not available — images will be skipped
  }

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useWorkerFetch: false,
    useSystemFonts: true,
    disableRange: true,
    disableStream: true,
  }).promise;

  const numPages = doc.numPages;
  const pages: PageData[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    let text = "";
    const images: Buffer[] = [];

    try {
      const textContent = await page.getTextContent();
      text = textContent.items
        .map((item) => {
          const i = item as { str?: string };
          return i.str ?? "";
        })
        .join(" ")
        .replace(/\s{2,}/g, " ")
        .trim();
    } catch {
      // ignore text extraction failure
    }

    if (sharpFn) {
      try {
        const ops = await page.getOperatorList();
        const seenKeys = new Set<string>();

        for (let i = 0; i < ops.fnArray.length; i++) {
          // pdfjs.OPS.paintImageXObject = 85; OPS.paintInlineImageXObject = 86
          if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject || ops.fnArray[i] === pdfjs.OPS.paintInlineImageXObject) {
            const imgKey: string = (ops.argsArray[i] as string[])?.[0] ?? "";
            if (!imgKey || seenKeys.has(imgKey)) continue;
            seenKeys.add(imgKey);

            try {
              const imgData = await new Promise<{
                data: Uint8ClampedArray;
                width: number;
                height: number;
                kind?: number;
              } | null>((resolve) => {
                try {
                  page.objs.get(imgKey, (data: unknown) => {
                    resolve(data as { data: Uint8ClampedArray; width: number; height: number; kind?: number } | null);
                  });
                } catch {
                  resolve(null);
                }
              });

              if (
                imgData &&
                imgData.data &&
                imgData.width >= 20 &&
                imgData.height >= 20
              ) {
                const rawBuf = Buffer.from(imgData.data.buffer);
                const channels = rawBuf.length / (imgData.width * imgData.height);
                if (channels === 3 || channels === 4) {
                  const pngBuf = await sharpFn(rawBuf, {
                    raw: { width: imgData.width, height: imgData.height, channels: channels as 3 | 4 },
                  })
                    .png()
                    .toBuffer();
                  images.push(pngBuf);
                }
              }
            } catch {
              // individual image extraction failure is not fatal
            }
          }
        }
      } catch {
        // operator list failure is not fatal
      }
    }

    pages.push({ pageNum, text, images });
    page.cleanup();
  }

  return pages;
}
