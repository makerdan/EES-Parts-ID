import sharp from "sharp";

export interface ResizedImages {
  fullBuffer: Buffer;
  thumbnailBuffer: Buffer;
}

/**
 * Resize an image buffer into two outputs:
 *   full      — longest edge capped at 800 px, JPEG quality 80
 *   thumbnail — longest edge capped at 200 px, JPEG quality 75
 *
 * Both operations are no-ops if the source is already within the target size.
 * The output content type is always image/jpeg.
 */
export async function resizeImages(input: Buffer): Promise<ResizedImages> {
  const fullBuffer = await sharp(input)
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const thumbnailBuffer = await sharp(input)
    .resize(200, 200, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  return { fullBuffer, thumbnailBuffer };
}
