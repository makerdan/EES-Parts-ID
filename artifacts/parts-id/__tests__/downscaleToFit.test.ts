/**
 * Unit tests for downscaleToFit and totalPayloadBytes in utils/resizeImage.ts.
 *
 * downscaleToFit walks a compression ladder of 6 steps, returning as soon as
 * the recompressed image fits within the byte budget, or falling back to a
 * raw FileSystem read when every step is exhausted.
 *
 * totalPayloadBytes sums the decoded byte size of an array of base64 / data-URI
 * strings (accepting either format).
 */

import { downscaleToFit, totalPayloadBytes, ImageReadError } from "../utils/resizeImage";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

const manipulateAsync = ImageManipulator.manipulateAsync as jest.Mock;
const readAsStringAsync = FileSystem.readAsStringAsync as jest.Mock;

const TEST_URI = "file:///test/photo.jpg";

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a base64 string whose decoded byte size is exactly `bytes`.
 * base64ByteSize(b64) = Math.ceil(b64.length * 3 / 4)
 * → b64.length = bytes * 4 / 3 (round up to nearest multiple of 4 for padding).
 */
function b64OfBytes(bytes: number): string {
  const len = Math.ceil((bytes * 4) / 3);
  return "A".repeat(len);
}

// ─── downscaleToFit ───────────────────────────────────────────────────────────

describe("downscaleToFit", () => {
  describe("ladder step 0 — returns immediately when image fits on the first attempt", () => {
    it("returns on the first ladder step when the recompressed image is within budget", async () => {
      const budget = 100;
      manipulateAsync.mockResolvedValueOnce({
        uri: "resized://step0.jpg",
        base64: b64OfBytes(50),
      });

      const result = await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenCalledTimes(1);
      expect(result.uri).toBe("resized://step0.jpg");
      expect(result.base64).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("first ladder step uses no resize action (targetWidth=0) and quality 0.5", async () => {
      manipulateAsync.mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(5) });

      await downscaleToFit(TEST_URI, 100);

      expect(manipulateAsync).toHaveBeenCalledWith(
        TEST_URI,
        [],
        expect.objectContaining({ compress: 0.5, base64: true }),
      );
    });
  });

  describe("ladder progression — each failing step advances to the next", () => {
    it("tries step 1 when step 0 produces an image that is still over budget", async () => {
      const budget = 50;
      manipulateAsync
        .mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(60) })
        .mockResolvedValueOnce({ uri: "r://s1.jpg", base64: b64OfBytes(30) });

      const result = await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenCalledTimes(2);
      expect(result.uri).toBe("r://s1.jpg");
    });

    it("step 1 also has no resize action (targetWidth=0) and quality 0.35", async () => {
      const budget = 50;
      manipulateAsync
        .mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(60) })
        .mockResolvedValueOnce({ uri: "r://s1.jpg", base64: b64OfBytes(30) });

      await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenNthCalledWith(
        2,
        "r://s0.jpg",
        [],
        expect.objectContaining({ compress: 0.35 }),
      );
    });

    it("step 2 uses resize action with width 1280 and quality 0.35", async () => {
      const budget = 20;
      manipulateAsync
        .mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(30) })
        .mockResolvedValueOnce({ uri: "r://s1.jpg", base64: b64OfBytes(25) })
        .mockResolvedValueOnce({ uri: "r://s2.jpg", base64: b64OfBytes(10) });

      await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenNthCalledWith(
        3,
        "r://s1.jpg",
        [{ resize: { width: 1280 } }],
        expect.objectContaining({ compress: 0.35 }),
      );
    });

    it("chains currentUri: each step receives the output URI of the previous step", async () => {
      const budget = 5;
      manipulateAsync
        .mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(10) })
        .mockResolvedValueOnce({ uri: "r://s1.jpg", base64: b64OfBytes(8) })
        .mockResolvedValueOnce({ uri: "r://s2.jpg", base64: b64OfBytes(6) })
        .mockResolvedValueOnce({ uri: "r://s3.jpg", base64: b64OfBytes(4) });

      await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenNthCalledWith(1, TEST_URI, [], expect.anything());
      expect(manipulateAsync).toHaveBeenNthCalledWith(2, "r://s0.jpg", [], expect.anything());
      expect(manipulateAsync).toHaveBeenNthCalledWith(3, "r://s1.jpg", [{ resize: { width: 1280 } }], expect.anything());
      expect(manipulateAsync).toHaveBeenNthCalledWith(4, "r://s2.jpg", [{ resize: { width: 960 } }], expect.anything());
    });

    it("returns immediately at step 3 (width 960, quality 0.25) when it first fits", async () => {
      const budget = 15;
      manipulateAsync
        .mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(20) })
        .mockResolvedValueOnce({ uri: "r://s1.jpg", base64: b64OfBytes(18) })
        .mockResolvedValueOnce({ uri: "r://s2.jpg", base64: b64OfBytes(17) })
        .mockResolvedValueOnce({ uri: "r://s3.jpg", base64: b64OfBytes(10) });

      const result = await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenCalledTimes(4);
      expect(result.uri).toBe("r://s3.jpg");
    });
  });

  describe("best-effort fallback — all ladder steps exhausted", () => {
    it("falls back to a FileSystem read when every ladder step exceeds the budget", async () => {
      const budget = 1;
      for (let i = 0; i < 6; i++) {
        manipulateAsync.mockResolvedValueOnce({
          uri: `r://s${i}.jpg`,
          base64: b64OfBytes(100),
        });
      }

      const result = await downscaleToFit(TEST_URI, budget);

      expect(manipulateAsync).toHaveBeenCalledTimes(6);
      expect(readAsStringAsync).toHaveBeenCalledTimes(1);
      expect(result.base64).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("best-effort FileSystem read uses the URI from the last ladder step", async () => {
      const budget = 1;
      for (let i = 0; i < 6; i++) {
        manipulateAsync.mockResolvedValueOnce({
          uri: `r://step${i}.jpg`,
          base64: b64OfBytes(100),
        });
      }

      await downscaleToFit(TEST_URI, budget);

      expect(readAsStringAsync).toHaveBeenCalledWith("r://step5.jpg", { encoding: "base64" });
    });

    it("best-effort result embeds the raw base64 from FileSystem", async () => {
      const budget = 1;
      for (let i = 0; i < 6; i++) {
        manipulateAsync.mockResolvedValueOnce({ uri: `r://s${i}.jpg`, base64: b64OfBytes(100) });
      }
      readAsStringAsync.mockResolvedValueOnce("FALLBACK_RAW_BASE64");

      const result = await downscaleToFit(TEST_URI, budget);

      expect(result.base64).toBe("data:image/jpeg;base64,FALLBACK_RAW_BASE64");
    });
  });

  describe("error handling", () => {
    it("throws ImageReadError when manipulateAsync throws on any ladder step", async () => {
      manipulateAsync.mockRejectedValueOnce(new Error("manipulator crash"));

      let caught: unknown;
      try {
        await downscaleToFit(TEST_URI, 100);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImageReadError);
      expect((caught as ImageReadError).message).toBe(
        "Could not compress the image — it may be in an unsupported format.",
      );
    });

    it("ImageReadError from manipulateAsync preserves the original cause", async () => {
      const originalError = new Error("unsupported format");
      manipulateAsync.mockRejectedValueOnce(originalError);

      let caught: unknown;
      try {
        await downscaleToFit(TEST_URI, 100);
      } catch (err) {
        caught = err;
      }

      expect((caught as ImageReadError).cause).toBe(originalError);
    });

    it("throws ImageReadError when the best-effort FileSystem read fails", async () => {
      const budget = 1;
      for (let i = 0; i < 6; i++) {
        manipulateAsync.mockResolvedValueOnce({ uri: `r://s${i}.jpg`, base64: b64OfBytes(100) });
      }
      readAsStringAsync.mockRejectedValueOnce(new Error("disk error"));

      let caught: unknown;
      try {
        await downscaleToFit(TEST_URI, budget);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImageReadError);
      expect((caught as ImageReadError).message).toBe(
        "Could not read compressed image data.",
      );
    });

    it("does not call FileSystem.readAsStringAsync when image fits before the ladder is exhausted", async () => {
      manipulateAsync.mockResolvedValueOnce({ uri: "r://s0.jpg", base64: b64OfBytes(5) });

      await downscaleToFit(TEST_URI, 100);

      expect(readAsStringAsync).not.toHaveBeenCalled();
    });
  });
});

// ─── totalPayloadBytes ────────────────────────────────────────────────────────

describe("totalPayloadBytes", () => {
  it("returns 0 for an empty array", () => {
    expect(totalPayloadBytes([])).toBe(0);
  });

  it("calculates the decoded byte size of a bare base64 string", () => {
    const b64 = "AAAA";
    expect(totalPayloadBytes([b64])).toBe(Math.ceil((b64.length * 3) / 4));
  });

  it("strips the data-URI prefix before calculating size", () => {
    const raw = "AAAA";
    const dataUri = `data:image/jpeg;base64,${raw}`;
    expect(totalPayloadBytes([dataUri])).toBe(totalPayloadBytes([raw]));
  });

  it("sums sizes across multiple images", () => {
    const a = "AAAA";
    const b = "BBBBBBBB";
    const expected =
      Math.ceil((a.length * 3) / 4) + Math.ceil((b.length * 3) / 4);
    expect(totalPayloadBytes([a, b])).toBe(expected);
  });

  it("handles a mix of bare base64 and data-URI strings in the same array", () => {
    const raw = "CCCC";
    const uri = `data:image/jpeg;base64,${raw}`;
    expect(totalPayloadBytes([raw, uri])).toBe(totalPayloadBytes([raw, raw]));
  });

  it("returns a value greater than 20 MB for a realistic oversized payload", () => {
    const twentyMbInBase64Chars = Math.ceil((20 * 1024 * 1024 * 4) / 3) + 1;
    const oversized = "A".repeat(twentyMbInBase64Chars);
    expect(totalPayloadBytes([oversized])).toBeGreaterThan(20 * 1024 * 1024);
  });
});
