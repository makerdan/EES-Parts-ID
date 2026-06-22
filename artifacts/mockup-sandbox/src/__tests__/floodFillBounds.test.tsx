import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { floodFillBounds, ZoneEditor } from "../pages/ZoneEditor";

// ── Helpers ────────────────────────────────────────────────────────────────────

type RGBA = [r: number, g: number, b: number, a: number];

const WHITE: RGBA = [255, 255, 255, 255]; // lum 255 — light
const BLACK: RGBA = [0, 0, 0, 255];       // lum 0   — dark
const TRANSPARENT: RGBA = [0, 0, 0, 0];   // alpha < 128 — treated as wall (dark)

/**
 * Build a synthetic ImageData-shaped object. jsdom does not expose the
 * ImageData constructor, but floodFillBounds only reads .data/.width/.height,
 * so a plain object with those fields is sufficient.
 */
function makeImageData(
  width: number,
  height: number,
  pixelFn: (x: number, y: number) => RGBA,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

/** All pixels are the given colour. */
function solidImage(width: number, height: number, colour: RGBA): ImageData {
  return makeImageData(width, height, () => colour);
}

/** Dark border, white interior. */
function borderedImage(width: number, height: number): ImageData {
  return makeImageData(width, height, (x, y) => {
    const onBorder = x === 0 || x === width - 1 || y === 0 || y === height - 1;
    return onBorder ? BLACK : WHITE;
  });
}

// ── Pure unit tests for floodFillBounds ──────────────────────────────────────

describe("floodFillBounds — pure BFS logic", () => {
  describe("seed on a light pixel", () => {
    it("returns a non-null result for an all-white image", () => {
      const img = solidImage(5, 5, WHITE);
      expect(floodFillBounds(img, 2, 2)).not.toBeNull();
    });

    it("covers the entire all-white image (single connected region)", () => {
      const img = solidImage(5, 5, WHITE);
      const result = floodFillBounds(img, 2, 2);
      expect(result).toEqual({ x: 0, y: 0, w: 5, h: 5 });
    });

    it("returns a single-pixel bounding box when only the seed pixel is light", () => {
      // 3×3 image: only the centre pixel is white, rest are black.
      const img = makeImageData(3, 3, (x, y) =>
        x === 1 && y === 1 ? WHITE : BLACK,
      );
      const result = floodFillBounds(img, 1, 1);
      expect(result).toEqual({ x: 1, y: 1, w: 1, h: 1 });
    });
  });

  describe("seed on a dark pixel", () => {
    it("returns null for an all-black image", () => {
      const img = solidImage(5, 5, BLACK);
      expect(floodFillBounds(img, 2, 2)).toBeNull();
    });

    it("returns null when the seed lands exactly on a dark pixel at (0,0)", () => {
      const img = solidImage(4, 4, BLACK);
      expect(floodFillBounds(img, 0, 0)).toBeNull();
    });

    it("returns null when clicking a dark wall pixel even if neighbours are light", () => {
      // Centre is black, all others white.
      const img = makeImageData(3, 3, (x, y) =>
        x === 1 && y === 1 ? BLACK : WHITE,
      );
      expect(floodFillBounds(img, 1, 1)).toBeNull();
    });
  });

  describe("transparent pixels", () => {
    it("treats a fully transparent pixel as a wall (returns null)", () => {
      const img = solidImage(3, 3, TRANSPARENT);
      expect(floodFillBounds(img, 1, 1)).toBeNull();
    });

    it("returns null when the seed is transparent even if surrounded by white", () => {
      // Centre pixel transparent, all others white.
      const img = makeImageData(3, 3, (x, y) =>
        x === 1 && y === 1 ? TRANSPARENT : WHITE,
      );
      expect(floodFillBounds(img, 1, 1)).toBeNull();
    });

    it("transparent pixels act as walls — white region does not bleed through them", () => {
      // Left half white, right half transparent; seed on left side.
      const img = makeImageData(6, 2, (x) => (x < 3 ? WHITE : TRANSPARENT));
      const result = floodFillBounds(img, 0, 0);
      // Only the white (left) half is reachable — transparent pixels block the fill.
      expect(result).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    });
  });

  describe("small enclosed region", () => {
    it("returns the interior bounds for a dark-bordered white rectangle", () => {
      // 7×7 image: one-pixel black border, 5×5 white interior.
      const img = borderedImage(7, 7);
      const result = floodFillBounds(img, 3, 3);
      // Interior spans x: 1..5, y: 1..5 → w=5, h=5.
      expect(result).toEqual({ x: 1, y: 1, w: 5, h: 5 });
    });

    it("does not bleed past dark walls into adjacent regions", () => {
      // Two separate white chambers separated by a black vertical wall at x=5.
      const img = makeImageData(11, 5, (x, y) => {
        if (x === 5) return BLACK;
        if (y === 0 || y === 4 || x === 0 || x === 10) return BLACK;
        return WHITE;
      });
      const leftResult = floodFillBounds(img, 2, 2);
      const rightResult = floodFillBounds(img, 8, 2);

      // Left chamber: x 1..4, right: x 6..9
      expect(leftResult).not.toBeNull();
      expect(rightResult).not.toBeNull();
      // The two regions must not overlap
      const leftMaxX = leftResult!.x + leftResult!.w - 1;
      const rightMinX = rightResult!.x;
      expect(leftMaxX).toBeLessThan(rightMinX);
    });

    it("respects a custom darkThreshold — pixel below threshold is treated as dark", () => {
      // Grey pixel: lum ≈ 128; default threshold 200 → dark.
      // With threshold 100 → light.
      const grey: RGBA = [128, 128, 128, 255];
      const img = solidImage(3, 3, grey);

      expect(floodFillBounds(img, 1, 1, 200)).toBeNull();  // grey is dark
      expect(floodFillBounds(img, 1, 1, 100)).not.toBeNull(); // grey is light
    });
  });

  describe("bounding box correctness", () => {
    it("returns x=0,y=0 when the light region starts at the image origin", () => {
      const img = solidImage(8, 6, WHITE);
      const result = floodFillBounds(img, 0, 0);
      expect(result?.x).toBe(0);
      expect(result?.y).toBe(0);
    });

    it("reports width and height of exactly 1 for a single isolated light pixel", () => {
      const img = makeImageData(5, 5, (x, y) =>
        x === 4 && y === 4 ? WHITE : BLACK,
      );
      const result = floodFillBounds(img, 4, 4);
      expect(result).toEqual({ x: 4, y: 4, w: 1, h: 1 });
    });

    it("returns width equal to image width for a full-width white stripe", () => {
      // Only row y=2 is white; rows 0,1,3,4 are black.
      const img = makeImageData(10, 5, (x, y) => (y === 2 ? WHITE : BLACK));
      const result = floodFillBounds(img, 5, 2);
      expect(result).toEqual({ x: 0, y: 2, w: 10, h: 1 });
    });
  });
});

// ── Integration test: fill mode sets pendingRect ──────────────────────────────

describe("ZoneEditor fill mode — integration", () => {
  // The rasterizeSvg function renders the SVG at up to 1024 px wide.
  // With the fallback SVG dims (2000×1000), the raster is 1024×512.
  const RASTER_W = 1024;
  const RASTER_H = 512;

  beforeEach(() => {
    // Pre-populate the admin token so the component skips the login modal.
    // Without this, the password <input> remains focused and interactions that
    // check document.activeElement silently no-op before reaching the canvas.
    sessionStorage.setItem("zoneEditorAdminToken", "test-token");

    vi.useFakeTimers();

    // Mock URL helpers used by rasterizeSvg.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-svg");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);

    // Make Image fire onload synchronously (via microtask) when src is assigned.
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      set(this: HTMLImageElement, _url: string) {
        // Schedule onload as a microtask so the Promise chain in rasterizeSvg proceeds.
        Promise.resolve().then(() => {
          this.onload?.(new Event("load"));
        });
      },
      configurable: true,
    });

    // Make canvas.getContext return a fake 2D context backed by an all-white ImageData.
    // Use a plain object since jsdom does not expose the ImageData constructor;
    // floodFillBounds only reads .data/.width/.height so this is sufficient.
    const allWhiteData = new Uint8ClampedArray(RASTER_W * RASTER_H * 4).fill(255);
    const fakeImageData = { data: allWhiteData, width: RASTER_W, height: RASTER_H, colorSpace: "srgb" } as unknown as ImageData;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue(fakeImageData),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    sessionStorage.removeItem("zoneEditorAdminToken");
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Restore the src property so other tests are not affected.
    delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).src;
  });

  it("click in fill mode sets pendingRect to a non-null rect", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ZoneEditor />));
    });

    // Click the "Fill" mode button.
    const fillBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Fill"),
    );
    expect(fillBtn).toBeDefined();
    await act(async () => {
      fillBtn!.click();
    });

    // Find the SVG canvas and stub its bounding rect for coordinate mapping.
    const svgEl = container.querySelector("svg") as SVGSVGElement;
    vi.spyOn(svgEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600,
      width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    });

    // Dispatch mousedown on the SVG (starts a fillPending interaction state).
    await act(async () => {
      svgEl.dispatchEvent(
        new MouseEvent("mousedown", { clientX: 50, clientY: 50, bubbles: true }),
      );
    });

    // Dispatch mouseup on the document (< 5 px movement → triggers fill).
    await act(async () => {
      document.dispatchEvent(
        new MouseEvent("mouseup", { clientX: 50, clientY: 50, bubbles: true }),
      );
    });

    // Allow the Image microtask (onload) to settle, then advance past the
    // 300 ms visual-feedback flash before pendingRect is committed.
    await act(async () => {
      await Promise.resolve(); // flush microtasks (Image onload → rasterizeSvg resolves)
      vi.advanceTimersByTime(350);
      await Promise.resolve(); // flush any follow-on microtasks
    });

    // "New Zone" label appears in the sidebar only when pendingRect is non-null.
    expect(container.textContent).toContain("New Zone");
  });
});
