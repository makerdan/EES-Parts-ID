import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

const MIN_WIDTH = 800;
const MAX_WIDTH = 1920;
const JPEG_QUALITY = 0.7;

export interface ResizedImage {
  uri: string;
  base64: string;
}

export async function resizeImage(
  uri: string,
  width: number
): Promise<ResizedImage> {
  // Unknown width (0 or negative): metadata unavailable — pass through without
  // resize rather than making an assumption about the image size.
  if (width <= 0 || (width >= MIN_WIDTH && width <= MAX_WIDTH)) {
    const raw = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
    return { uri, base64: `data:image/jpeg;base64,${raw}` };
  }

  // width > MAX_WIDTH → downscale; width < MIN_WIDTH → upscale.
  const targetWidth = width > MAX_WIDTH ? MAX_WIDTH : MIN_WIDTH;

  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: targetWidth } }],
    { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true }
  );

  const base64 = result.base64
    ? `data:image/jpeg;base64,${result.base64}`
    : result.uri;

  return { uri: result.uri, base64 };
}
