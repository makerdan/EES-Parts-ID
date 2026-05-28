import { useEffect } from "react";

const API_BASE = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
  : "";

/**
 * Fire-and-forget screen view tracking.
 * Sends a POST to /api/track/screen-view on mount.
 * Errors are silently swallowed — this must never disrupt the UI.
 */
export function useTrackScreen(screenName: string): void {
  useEffect(() => {
    if (!API_BASE) return;
    fetch(`${API_BASE}/track/screen-view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screen: screenName }),
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
