import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";

const MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.7;

export interface ResizedImage {
  uri: string;
  base64: string;
}

export class ImageReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ImageReadError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export async function resizeImage(
  uri: string,
  width: number
): Promise<ResizedImage> {
  // Only downscale when the image exceeds MAX_WIDTH. All other cases — unknown
  // width (0 or negative), already within range, or narrower than MIN_WIDTH —
  // are passed through unchanged. Upscaling small images increases token cost
  // and payload size with no quality benefit.
  if (width <= 0 || width <= MAX_WIDTH) {
    try {
      const raw = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
      return { uri, base64: `data:image/jpeg;base64,${raw}` };
    } catch (err) {
      throw new ImageReadError(
        "Could not read the image file — it may be corrupt, deleted, or inaccessible.",
        err
      );
    }
  }

  // width > MAX_WIDTH → downscale only.
  const targetWidth = MAX_WIDTH;

  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: targetWidth } }],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    const base64 = result.base64
      ? `data:image/jpeg;base64,${result.base64}`
      : result.uri;

    return { uri: result.uri, base64 };
  } catch (err) {
    throw new ImageReadError(
      "Could not process the image — it may be corrupt, in an unsupported format, or the URI is stale.",
      err
    );
  }
}
