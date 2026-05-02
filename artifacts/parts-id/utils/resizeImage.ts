/**
 * On-device image resize helper used before /ai/identify uploads.
 *
 * Phones in the warehouse routinely produce 12MP photos. Sending those
 * directly to OpenAI would slow the round-trip and burn token budget
 * needlessly — the model only needs ~1024px on the long edge to identify
 * a part. We use `expo-image-manipulator` and return a base64 payload.
 */
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

const MIN_WIDTH = 800;
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
  // Unknown width (0 or negative): metadata unavailable — pass through without
  // resize rather than making an assumption about the image size.
  if (width <= 0 || (width >= MIN_WIDTH && width <= MAX_WIDTH)) {
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

  // width > MAX_WIDTH → downscale; width < MIN_WIDTH → upscale.
  const targetWidth = width > MAX_WIDTH ? MAX_WIDTH : MIN_WIDTH;

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
