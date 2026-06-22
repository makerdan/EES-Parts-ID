import { resizeImage, ImageReadError } from "../utils/resizeImage";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

const manipulateAsync = ImageManipulator.manipulateAsync as jest.Mock;
const readAsStringAsync = FileSystem.readAsStringAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("resizeImage", () => {
  const TEST_URI = "file:///test/image.jpg";

  describe("width within range (800–1920) — pass through without resize", () => {
    it("passes through an image exactly at 800px", async () => {
      const result = await resizeImage(TEST_URI, 800);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(readAsStringAsync).toHaveBeenCalledWith(TEST_URI, { encoding: "base64" });
      expect(result.uri).toBe(TEST_URI);
      expect(result.base64).toBe("data:image/jpeg;base64,RAW_BASE64");
    });

    it("passes through an image exactly at 1920px", async () => {
      const result = await resizeImage(TEST_URI, 1920);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(readAsStringAsync).toHaveBeenCalledWith(TEST_URI, { encoding: "base64" });
      expect(result.uri).toBe(TEST_URI);
      expect(result.base64).toBe("data:image/jpeg;base64,RAW_BASE64");
    });

    it("passes through an image at a typical mid-range width (1280px)", async () => {
      const result = await resizeImage(TEST_URI, 1280);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(result.uri).toBe(TEST_URI);
    });
  });

  describe("width below 800 — pass through without upscale", () => {
    it("passes through a small image (400px) without resizing", async () => {
      const result = await resizeImage(TEST_URI, 400);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(readAsStringAsync).toHaveBeenCalledWith(TEST_URI, { encoding: "base64" });
      expect(result.uri).toBe(TEST_URI);
      expect(result.base64).toBe("data:image/jpeg;base64,RAW_BASE64");
    });

    it("passes through an image at 799px (just below minimum) without resizing", async () => {
      const result = await resizeImage(TEST_URI, 799);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(result.uri).toBe(TEST_URI);
    });

    it("passes through a very small image (1px) without resizing", async () => {
      const result = await resizeImage(TEST_URI, 1);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(result.uri).toBe(TEST_URI);
    });
  });

  describe("width above 1920 — downscale to 1920px", () => {
    it("downscales a large image (4000px) to 1920px", async () => {
      const result = await resizeImage(TEST_URI, 4000);

      expect(manipulateAsync).toHaveBeenCalledWith(
        TEST_URI,
        [{ resize: { width: 1920 } }],
        expect.objectContaining({ base64: true })
      );
      expect(result.uri).toBe(`resized://${TEST_URI}`);
      expect(result.base64).toBe("data:image/jpeg;base64,RESIZED_BASE64");
    });

    it("downscales an image at 1921px (just above maximum) to 1920px", async () => {
      await resizeImage(TEST_URI, 1921);

      expect(manipulateAsync).toHaveBeenCalledWith(
        TEST_URI,
        [{ resize: { width: 1920 } }],
        expect.anything()
      );
    });
  });

  describe("unknown / zero width — fall back gracefully without resize", () => {
    it("skips resize and reads raw file when width is 0", async () => {
      const result = await resizeImage(TEST_URI, 0);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(readAsStringAsync).toHaveBeenCalledWith(TEST_URI, { encoding: "base64" });
      expect(result.uri).toBe(TEST_URI);
      expect(result.base64).toBe("data:image/jpeg;base64,RAW_BASE64");
    });

    it("skips resize and reads raw file when width is negative", async () => {
      const result = await resizeImage(TEST_URI, -1);

      expect(manipulateAsync).not.toHaveBeenCalled();
      expect(readAsStringAsync).toHaveBeenCalledWith(TEST_URI, { encoding: "base64" });
      expect(result.uri).toBe(TEST_URI);
    });
  });

  describe("base64 fallback when manipulateAsync returns no base64", () => {
    it("falls back to result.uri when base64 is undefined", async () => {
      manipulateAsync.mockResolvedValueOnce({
        uri: "resized://fallback.jpg",
        base64: undefined,
      });

      const result = await resizeImage(TEST_URI, 4000);

      expect(result.base64).toBe("resized://fallback.jpg");
      expect(result.uri).toBe("resized://fallback.jpg");
    });
  });

  describe("error handling — corrupt or unreadable images", () => {
    it("throws ImageReadError with readable message when readAsStringAsync fails (pass-through path)", async () => {
      readAsStringAsync.mockRejectedValueOnce(new Error("File not found"));

      let caught: unknown;
      try {
        await resizeImage(TEST_URI, 1000);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImageReadError);
      expect((caught as ImageReadError).name).toBe("ImageReadError");
      expect((caught as ImageReadError).message).toBe(
        "Could not read the image file — it may be corrupt, deleted, or inaccessible."
      );
    });

    it("throws ImageReadError with readable message when manipulateAsync fails (resize path)", async () => {
      manipulateAsync.mockRejectedValueOnce(new Error("Corrupt image data"));

      let caught: unknown;
      try {
        await resizeImage(TEST_URI, 4000);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImageReadError);
      expect((caught as ImageReadError).name).toBe("ImageReadError");
      expect((caught as ImageReadError).message).toBe(
        "Could not process the image — it may be corrupt, in an unsupported format, or the URI is stale."
      );
    });

    it("preserves the original cause on ImageReadError", async () => {
      const originalError = new Error("Device storage unavailable");
      readAsStringAsync.mockRejectedValueOnce(originalError);

      let caught: unknown;
      try {
        await resizeImage(TEST_URI, 900);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImageReadError);
      expect((caught as ImageReadError).cause).toBe(originalError);
    });
  });
});
