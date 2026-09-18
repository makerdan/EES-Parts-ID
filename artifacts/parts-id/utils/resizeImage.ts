import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { Platform } from "react-native";

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

/**
 * Decode base64 string (with or without data: URI prefix) to byte size (upper bound).
 */
function base64ByteSize(b64OrDataUri: string): number {
  const b64 = b64OrDataUri.startsWith("data:")
    ? (b64OrDataUri.split(",")[1] ?? "")
    : b64OrDataUri;
  return Math.ceil((b64.length * 3) / 4);
}

/**
 * Read a URI as a base64-encoded JPEG data URI, working on both native and web.
 *
 * On native, expo-file-system reads file:// URIs directly (fast, preserves
 * original bytes as-is).
 * On web, expo-image-picker returns blob:// URIs that expo-file-system cannot
 * read. ImageManipulator uses the HTML canvas API and handles blob/data URIs
 * correctly on all browsers.
 */
async function readAsBase64(uri: string): Promise<string> {
  if (Platform.OS === "web") {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    return `data:image/jpeg;base64,${result.base64 ?? ""}`;
  }
  const raw = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
  return `data:image/jpeg;base64,${raw}`;
}

/**
 * Compression ladder used by downscaleToFit.
 * Each entry is [maxWidth (0 = no resize), jpegQuality].
 * Steps are tried in order until the image fits within the byte budget.
 */
const COMPRESSION_LADDER: Array<[number, number]> = [
  [0, 0.5],
  [0, 0.35],
  [1280, 0.35],
  [960, 0.25],
  [800, 0.2],
  [640, 0.15],
];

/**
 * Re-compress `uri` until its base64 size fits within `maxBytes`.
 * Walks a compression ladder of progressively lower quality / smaller dimensions.
 * If the image fits at the last step, returns that result regardless (best effort).
 *
 * @param uri      Local image URI (file:// on native, blob:// on web)
 * @param maxBytes Maximum allowed decoded byte size for this single image
 */
export async function downscaleToFit(
  uri: string,
  maxBytes: number,
): Promise<ResizedImage> {
  let currentUri = uri;

  for (const [targetWidth, quality] of COMPRESSION_LADDER) {
    const actions: Array<ImageManipulator.Action> =
      targetWidth > 0 ? [{ resize: { width: targetWidth } }] : [];

    try {
      const result = await ImageManipulator.manipulateAsync(
        currentUri,
        actions,
        { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );

      const b64 = result.base64 ?? "";
      if (base64ByteSize(b64) <= maxBytes) {
        return { uri: result.uri, base64: `data:image/jpeg;base64,${b64}` };
      }
      currentUri = result.uri;
    } catch (err) {
      throw new ImageReadError(
        "Could not compress the image — it may be in an unsupported format.",
        err,
      );
    }
  }

  // Best effort: return the result of the final ladder step.
  // Use readAsBase64 so this path works on both native (file://) and
  // web (blob:// or data: URI produced by ImageManipulator above).
  try {
    const base64 = await readAsBase64(currentUri);
    return { uri: currentUri, base64 };
  } catch (err) {
    throw new ImageReadError(
      "Could not read compressed image data.",
      err,
    );
  }
}

/**
 * Calculate total decoded byte size across an array of base64/data-URI strings.
 */
export function totalPayloadBytes(images: Array<string>): number {
  return images.reduce((sum, img) => sum + base64ByteSize(img), 0);
}

export async function resizeImage(
  uri: string,
  width: number
): Promise<ResizedImage> {
  // Only downscale when the image exceeds MAX_WIDTH. All other cases — unknown
  // width (0 or negative), already within range, or narrower than MAX_WIDTH —
  // are passed through. Upscaling small images increases token cost and payload
  // size with no quality benefit.
  //
  // On native, expo-file-system reads file:// URIs directly.
  // On web, expo-image-picker returns blob:// URIs which expo-file-system
  // cannot read — readAsBase64 routes those through ImageManipulator (canvas).
  if (width <= 0 || width <= MAX_WIDTH) {
    try {
      const base64 = await readAsBase64(uri);
      return { uri, base64 };
    } catch (err) {
      throw new ImageReadError(
        "Could not read the image file — it may be corrupt, deleted, or inaccessible.",
        err,
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
