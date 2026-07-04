import { Platform } from "react-native";

export const API_BASE: string =
  process.env.EXPO_PUBLIC_API_BASE ??
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : Platform.OS !== "web"
      ? "http://localhost:8080/api"
      : "");

/**
 * Bare origin (no path) for the generated API client's setBaseUrl().
 * The generated client paths already start with /api/…, so including any
 * path here would double the prefix. Empty string means "use relative URLs"
 * (web dev — no base URL needed).
 */
function deriveApiOrigin(): string {
  if (process.env.EXPO_PUBLIC_API_BASE) {
    try {
      return new URL(process.env.EXPO_PUBLIC_API_BASE).origin;
    } catch {
      return process.env.EXPO_PUBLIC_API_BASE.replace(/\/api$/, "");
    }
  }
  if (process.env.EXPO_PUBLIC_DOMAIN) {
    return `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
  }
  if (Platform.OS !== "web") {
    return "http://localhost:8080";
  }
  return "";
}

export const API_ORIGIN: string = deriveApiOrigin();

if (
  API_ORIGIN === "http://localhost:8080" &&
  Platform.OS !== "web" &&
  !__DEV__
) {
  throw new Error(
    "[apiBase] API origin is not configured for this production build. " +
      "Set EXPO_PUBLIC_API_BASE or EXPO_PUBLIC_DOMAIN before building.",
  );
}
