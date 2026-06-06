/**
 * Web Worker — BFS flood-fill for the Zone Editor fill mode.
 *
 * Receives an SVG string + click coordinates, rasterises the SVG using
 * OffscreenCanvas + createImageBitmap (both available in workers), runs BFS
 * flood-fill to find the bounding box of the clicked light region, and posts
 * the result back to the main thread.
 *
 * A module-level raster cache (keyed on the SVG string) avoids re-rasterising
 * the floor plan on every fill click, matching the behaviour of the previous
 * main-thread implementation.
 */

export interface FillWorkerRequest {
  svgInner: string;
  dims: { w: number; h: number };
  px: number;
  py: number;
  darkThreshold: number;
}

export type FillWorkerResponse =
  | { ok: true; bounds: { x: number; y: number; w: number; h: number } | null }
  | { ok: false; error: string };

let _cache: { key: string; imageData: ImageData; w: number; h: number } | null = null;

self.onmessage = async (e: MessageEvent<FillWorkerRequest>) => {
  const { svgInner, dims, px, py, darkThreshold } = e.data;
  try {
    let raster: { imageData: ImageData; w: number; h: number };

    if (_cache && _cache.key === svgInner) {
      raster = { imageData: _cache.imageData, w: _cache.w, h: _cache.h };
    } else {
      const maxPx = 1024;
      const aspect = dims.h / dims.w;
      const cw = Math.min(Math.round(dims.w), maxPx);
      const ch = Math.max(1, Math.round(cw * aspect));

      const svgStr = [
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
        ` viewBox="0 0 ${dims.w} ${dims.h}" width="${cw}" height="${ch}">`,
        svgInner,
        `</svg>`,
      ].join("");

      const blob = new Blob([svgStr], { type: "image/svg+xml" });
      const bitmap = await createImageBitmap(blob);

      const canvas = new OffscreenCanvas(cw, ch);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No 2D canvas context in worker");

      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const imageData = ctx.getImageData(0, 0, cw, ch);
      _cache = { key: svgInner, imageData, w: cw, h: ch };
      raster = { imageData, w: cw, h: ch };
    }

    const bounds = floodFillBounds(raster.imageData, px, py, darkThreshold);
    const response: FillWorkerResponse = { ok: true, bounds };
    self.postMessage(response);
  } catch (err) {
    const response: FillWorkerResponse = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

function floodFillBounds(
  imageData: ImageData,
  startX: number,
  startY: number,
  darkThreshold = 200,
): { x: number; y: number; w: number; h: number } | null {
  const { data, width, height } = imageData;

  const isLight = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    const i = (y * width + x) * 4;
    const a = data[i + 3];
    if (a < 128) return false;
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum >= darkThreshold;
  };

  if (!isLight(startX, startY)) return null;

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const seedPos = startY * width + startX;
  visited[seedPos] = 1;
  stack.push(seedPos);

  let minX = startX, maxX = startX, minY = startY, maxY = startY;

  while (stack.length > 0) {
    const pos = stack.pop()!;
    const x = pos % width;
    const y = (pos / width) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    const neighbors: [number, number][] = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const vi = ny * width + nx;
        if (!visited[vi] && isLight(nx, ny)) {
          visited[vi] = 1;
          stack.push(vi);
        }
      }
    }
  }

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
