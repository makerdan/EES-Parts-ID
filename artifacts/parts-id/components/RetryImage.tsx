import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image } from "react-native";
import type { ImageStyle, StyleProp } from "react-native";
import { retryAsync } from "@/utils/retryAsync";

interface RetryImageProps {
  uri: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: "contain" | "cover" | "stretch" | "center";
  /** Total attempts including the initial load. Default: 3. */
  maxAttempts?: number;
  /** Delay between retry attempts in ms. Default: 800. */
  retryDelayMs?: number;
}

/**
 * Drop-in replacement for <Image source={{ uri }} /> that automatically retries
 * failed loads via `retryAsync` (Image.prefetch) before falling back to native
 * broken-image behaviour.
 *
 * On a stable connection the image renders immediately — no prefetch delay.
 * On transient failures, `retryAsync` drives up to (maxAttempts - 1) retry
 * attempts. After all retries are exhausted the Image is rendered one final time
 * so the native platform's broken-image state is shown rather than nothing.
 */
export function RetryImage({
  uri,
  style,
  resizeMode,
  maxAttempts = 3,
  retryDelayMs = 800,
}: RetryImageProps) {
  // Bumping this key forces React Native to re-create the Image view.
  const [imageKey, setImageKey] = useState(0);
  const retryingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const cancelledRef = useRef(false);

  // Reset all flags when the URI changes so a fresh image starts clean.
  useEffect(() => {
    cancelledRef.current = false;
    retryingRef.current = false;
    exhaustedRef.current = false;
    setImageKey(0);
    return () => {
      cancelledRef.current = true;
    };
  }, [uri]);

  const handleError = useCallback(() => {
    if (retryingRef.current || exhaustedRef.current || cancelledRef.current) return;
    retryingRef.current = true;

    // The first attempt already failed (onError fired), so we have
    // (maxAttempts - 1) retries remaining. Use retryAsync + Image.prefetch to
    // schedule them with the standard project retry semantics.
    retryAsync(
      async () => {
        const ok = await Image.prefetch(uri);
        if (!ok) throw new Error("prefetch returned false");
      },
      { maxAttempts: maxAttempts - 1, delayMs: retryDelayMs },
    )
      .then(() => {
        // Prefetch succeeded — bump key so Image re-renders from native cache.
        if (!cancelledRef.current) setImageKey((k) => k + 1);
      })
      .catch(() => {
        // All retries exhausted — bump key so native broken-image state shows.
        exhaustedRef.current = true;
        if (!cancelledRef.current) setImageKey((k) => k + 1);
      })
      .finally(() => {
        retryingRef.current = false;
      });
  }, [uri, maxAttempts, retryDelayMs]);

  return (
    <Image
      key={imageKey}
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onError={exhaustedRef.current ? undefined : handleError}
    />
  );
}
