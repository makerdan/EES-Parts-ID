/**
 * Integration-style tests for compressImagesForUpload (utils/compressForUpload.ts).
 *
 * These tests verify the three behaviours described in the task:
 *   1. When the total payload is within 20 MB the images are returned unchanged
 *      and neither downscaleToFit nor the toast fires.
 *   2. When the total payload exceeds 20 MB, downscaleToFit is called for every
 *      image and the "Photos compressed for upload" toast is shown.
 *   3. When downscaleToFit throws, the original images are returned unchanged
 *      (the identify call is NOT blocked).
 *
 * Both totalPayloadBytes and downscaleToFit are mocked so the tests are fast
 * and deterministic without touching FileSystem or ImageManipulator.
 */

import { compressImagesForUpload, MAX_UPLOAD_PAYLOAD_BYTES } from "../utils/compressForUpload";

jest.mock("../utils/resizeImage", () => ({
  totalPayloadBytes: jest.fn(),
  downscaleToFit: jest.fn(),
}));

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
  it("calls downscaleToFit once per image when payload is over 20 MB", async () => {
    const images = makeImages(3);
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
      images[0].base64,
      images[1].base64,
    ]);
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
    expect(result[0].uri).toBe("file:///photo0.jpg");
  });
});
