import { downscaleToFit, totalPayloadBytes } from "./resizeImage";

export const MAX_UPLOAD_PAYLOAD_BYTES = 20 * 1024 * 1024;

export interface ImageEntry {
  uri: string;
  base64: string;
}

/**
 * Pre-flight compression: if the total decoded size of `images` exceeds the
 * 20 MB AI payload limit, walks the downscale ladder on every image so the
 * combined payload lands safely below the cap.
 *
 * On success, fires `showToast` to inform the user and returns the compressed
 * set.  On failure (downscaleToFit throws), silently falls back to the
 * originals — the server-side 413 path will surface an error if still too large.
 */
export async function compressImagesForUpload(
  images: Array<ImageEntry>,
  showToast: (message: string) => void,
): Promise<Array<ImageEntry>> {
  const payloadBytes = totalPayloadBytes(images.map((i) => i.base64));
  if (payloadBytes <= MAX_UPLOAD_PAYLOAD_BYTES) return images;

  const budgetPerImage = Math.floor(
    (MAX_UPLOAD_PAYLOAD_BYTES * 0.9) / images.length,
  );
  try {
    const compressed = await Promise.all(
      images.map((img) => downscaleToFit(img.uri, budgetPerImage)),
    );
    showToast("Photos compressed for upload");
    return compressed.map((r) => ({ uri: r.uri, base64: r.base64 }));
  } catch {
    return images;
  }
}
