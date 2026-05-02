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
  // Only skip resize when width is known and already within the acceptable band
  if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
    const raw = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
    return { uri, base64: `data:image/jpeg;base64,${raw}` };
  }

  // width <= 0 means the asset metadata didn't provide a dimension — apply a
  // conservative MAX_WIDTH resize rather than forwarding a potentially huge image.
  const targetWidth = width <= 0 || width > MAX_WIDTH ? MAX_WIDTH : MIN_WIDTH;

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
