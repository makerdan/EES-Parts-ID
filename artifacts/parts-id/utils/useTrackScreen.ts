import {
  SCREEN_EVENT_VERSION,
  type ScreenViewEvent,
  ScreenViewEventSchema,
} from "@workspace/api-zod";
import { useEffect } from "react";

import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";

/**
 * Fire-and-forget screen view tracking.
 * Sends a POST to /api/track/screen-view on mount.
 * Errors are silently swallowed — this must never disrupt the UI.
 */
export function useTrackScreen(screenName: ScreenViewEvent["screen"]): void {
  useEffect(() => {
    if (!API_BASE) return;
    const result = ScreenViewEventSchema.safeParse({
      version: SCREEN_EVENT_VERSION,
      event: "screen_view",
      screen: screenName,
    });
    if (!result.success) return;
    fetchWithAuth(`${API_BASE}/track/screen-view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.data),
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
