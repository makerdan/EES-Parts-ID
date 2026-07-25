/**
 * Integration-style tests for compressImagesForUpload (utils/compressForUpload.ts).
 *
 * These tests verify the four behaviours:
 *   1. When the total payload is within 20 MB the images are returned unchanged
 *      and neither downscaleToFit nor the toast fires.
 *   2. When the total payload exceeds 20 MB, downscaleToFit is called only for
 *      images that exceed their per-image budget, and the
 *      "Photos compressed for upload" toast is shown.
 *   3. Images already within their per-image budget are passed through unchanged
 *      even when the total payload exceeds 20 MB.
 *   4. When downscaleToFit throws, the original images are returned unchanged
 *      (the identify call is NOT blocked).
 *
 * Both totalPayloadBytes and downscaleToFit are mocked so the tests are fast
 * and deterministic without touching FileSystem or ImageManipulator.
 */

import { compressImagesForUpload, MAX_UPLOAD_PAYLOAD_BYTES } from "../utils/compressForUpload";

jest.mock("../utils/resizeImage", () => {
  const actual = jest.requireActual<typeof import("../utils/resizeImage")>("../utils/resizeImage");
  return {
    ...actual,
    totalPayloadBytes: jest.fn(),
    downscaleToFit: jest.fn(),
  };
});

import { totalPayloadBytes, downscaleToFit } from "../utils/resizeImage";

const mockTotalPayloadBytes = totalPayloadBytes as jest.Mock;
const mockDownscaleToFit = downscaleToFit as jest.Mock;

function makeImages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uri: `file:///photo${i}.jpg`,
    base64: `data:image/jpeg;base64,BASE64_${i}`,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── payload within limit ─────────────────────────────────────────────────────

describe("payload within the 20 MB limit — no compression needed", () => {
  it("returns the original images unchanged when total bytes are exactly at the limit", async () => {
    const images = makeImages(1);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES);

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toBe(images);
    expect(mockDownscaleToFit).not.toHaveBeenCalled();
  });

  it("returns the original images unchanged when total bytes are below the limit", async () => {
    const images = makeImages(2);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES - 1);

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toBe(images);
    expect(mockDownscaleToFit).not.toHaveBeenCalled();
  });

  it("does not call showToast when no compression is needed", async () => {
    const images = makeImages(1);
    mockTotalPayloadBytes.mockReturnValue(1024);
    const showToast = jest.fn();

    await compressImagesForUpload(images, showToast);

    expect(showToast).not.toHaveBeenCalled();
  });
});

// ─── payload exceeds limit ────────────────────────────────────────────────────

describe("payload exceeds the 20 MB limit — compression triggered", () => {
  it("calls downscaleToFit for every image when all images exceed their per-image budget", async () => {
    const images = makeImages(3);
    // totalPayloadBytes returns an oversized value for every call (total + per-image checks)
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockImplementation(async (uri: string) => ({
      uri,
      base64: "data:image/jpeg;base64,COMPRESSED",
    }));

    await compressImagesForUpload(images, jest.fn());

    expect(mockDownscaleToFit).toHaveBeenCalledTimes(3);
  });

  it("calls downscaleToFit with each image URI", async () => {
    const images = makeImages(2);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockImplementation(async (uri: string) => ({
      uri,
      base64: "data:image/jpeg;base64,COMPRESSED",
    }));

    await compressImagesForUpload(images, jest.fn());

    expect(mockDownscaleToFit).toHaveBeenCalledWith(
      "file:///photo0.jpg",
      expect.any(Number),
    );
    expect(mockDownscaleToFit).toHaveBeenCalledWith(
      "file:///photo1.jpg",
      expect.any(Number),
    );
  });

  it("distributes a 90 % budget equally across all images", async () => {
    const images = makeImages(3);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockImplementation(async (uri: string) => ({
      uri,
      base64: "data:image/jpeg;base64,COMPRESSED",
    }));

    await compressImagesForUpload(images, jest.fn());

    const expectedBudget = Math.floor((MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / 3);
    for (const call of mockDownscaleToFit.mock.calls) {
      expect(call[1]).toBe(expectedBudget);
    }
  });

  it("shows the 'Photos compressed for upload' toast after successful compression", async () => {
    const images = makeImages(1);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockResolvedValue({ uri: "r://c.jpg", base64: "data:image/jpeg;base64,C" });
    const showToast = jest.fn();

    await compressImagesForUpload(images, showToast);

    expect(showToast).toHaveBeenCalledWith("Photos compressed for upload");
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("returns the compressed images (not the originals) after successful compression", async () => {
    const images = makeImages(2);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit
      .mockResolvedValueOnce({ uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" })
      .mockResolvedValueOnce({ uri: "r://c1.jpg", base64: "data:image/jpeg;base64,COMP1" });

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toEqual([
      { uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" },
      { uri: "r://c1.jpg", base64: "data:image/jpeg;base64,COMP1" },
    ]);
  });

  it("totalPayloadBytes is called with all image base64 strings", async () => {
    const images = makeImages(2);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES - 1);

    await compressImagesForUpload(images, jest.fn());

    expect(mockTotalPayloadBytes).toHaveBeenCalledWith([
      images[0]!.base64,
      images[1]!.base64,
    ]);
  });
});

// ─── selective compression — only oversized images are recompressed ───────────

describe("selective compression — only oversized images are recompressed", () => {
  it("skips downscaleToFit for an image already within its per-image budget", async () => {
    const images = makeImages(2);
    const budgetPerImage = Math.floor((MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / 2);

    // First call: total payload check — over the limit
    mockTotalPayloadBytes.mockReturnValueOnce(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    // Second call: per-image check for image 0 — over budget, must compress
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage + 1);
    // Third call: per-image check for image 1 — already within budget, skip
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage - 1);

    mockDownscaleToFit.mockResolvedValue({ uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" });

    await compressImagesForUpload(images, jest.fn());

    expect(mockDownscaleToFit).toHaveBeenCalledTimes(1);
    expect(mockDownscaleToFit).toHaveBeenCalledWith("file:///photo0.jpg", budgetPerImage);
  });

  it("leaves already-small images unchanged in the result", async () => {
    const images = makeImages(2);
    const budgetPerImage = Math.floor((MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / 2);

    mockTotalPayloadBytes.mockReturnValueOnce(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage + 1); // image 0: oversized
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage - 1); // image 1: fits

    mockDownscaleToFit.mockResolvedValue({ uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" });

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toEqual([
      { uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" },
      { uri: "file:///photo1.jpg", base64: "data:image/jpeg;base64,BASE64_1" },
    ]);
  });

  it("does not call downscaleToFit at all when every image is already within budget", async () => {
    const images = makeImages(3);
    const budgetPerImage = Math.floor((MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / 3);

    // Total is over the limit but each individual image fits its share
    mockTotalPayloadBytes.mockReturnValueOnce(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockTotalPayloadBytes.mockReturnValue(budgetPerImage - 1);

    await compressImagesForUpload(images, jest.fn());

    expect(mockDownscaleToFit).not.toHaveBeenCalled();
  });

  it("still shows the toast even when only one image required compression", async () => {
    const images = makeImages(2);
    const budgetPerImage = Math.floor((MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / 2);

    mockTotalPayloadBytes.mockReturnValueOnce(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage + 1); // image 0: oversized
    mockTotalPayloadBytes.mockReturnValueOnce(budgetPerImage - 1); // image 1: fits

    mockDownscaleToFit.mockResolvedValue({ uri: "r://c0.jpg", base64: "data:image/jpeg;base64,COMP0" });
    const showToast = jest.fn();

    await compressImagesForUpload(images, showToast);

    expect(showToast).toHaveBeenCalledWith("Photos compressed for upload");
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

// ─── fallback path — downscale throws ────────────────────────────────────────

describe("fallback path — downscaleToFit throws", () => {
  it("returns the original images when downscaleToFit rejects", async () => {
    const images = makeImages(2);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockRejectedValue(new Error("compression failure"));

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toBe(images);
  });

  it("does NOT throw when downscaleToFit rejects (identify call is not blocked)", async () => {
    const images = makeImages(1);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockRejectedValue(new Error("compression failure"));

    await expect(compressImagesForUpload(images, jest.fn())).resolves.not.toThrow();
  });

  it("does not show the toast when downscaleToFit fails", async () => {
    const images = makeImages(1);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockRejectedValue(new Error("compression failure"));
    const showToast = jest.fn();

    await compressImagesForUpload(images, showToast);

    expect(showToast).not.toHaveBeenCalled();
  });

  it("returns the original images (not an empty array) after a compression failure", async () => {
    const images = makeImages(3);
    mockTotalPayloadBytes.mockReturnValue(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    mockDownscaleToFit.mockRejectedValue(new Error("ImageReadError"));

    const result = await compressImagesForUpload(images, jest.fn());

    expect(result).toHaveLength(3);
    expect(result[0]!.uri).toBe("file:///photo0.jpg");
  });
});
