import { Platform } from "react-native";

export const API_BASE: string =
  process.env.EXPO_PUBLIC_API_BASE ??
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : Platform.OS !== "web"
      ? "http://localhost:8080/api"
      : "");

/**
 * Bare origin (no /api suffix) for the generated API client's setBaseUrl().
 * The generated client paths already start with /api/…, so including /api
 * here would double the prefix. Empty string means "use relative URLs"
 * (web dev — no base URL needed).
 */
export const API_ORIGIN: string =
  process.env.EXPO_PUBLIC_API_BASE
    ? process.env.EXPO_PUBLIC_API_BASE.replace(/\/api$/, "")
    : process.env.EXPO_PUBLIC_DOMAIN
      ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
      : Platform.OS !== "web"
        ? "http://localhost:8080"
        : "";
