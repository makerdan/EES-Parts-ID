import React, { useEffect, useRef, useState } from "react";
import { Image } from "react-native";
import type { ImageStyle, StyleProp } from "react-native";

interface RetryImageProps {
  uri: string;
  style?: StyleProp<ImageStyle>;
  resizeMode?: "contain" | "cover" | "stretch" | "center";
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Drop-in replacement for <Image source={{ uri }} /> that automatically retries
 * up to `maxAttempts` times (default 3) with a short delay before giving up and
 * rendering nothing. Mirrors the resilience of `retryAsync` for image loads.
 */
export function RetryImage({
  uri,
  style,
  resizeMode,
  maxAttempts = 3,
  retryDelayMs = 800,
}: RetryImageProps) {
  const [attemptKey, setAttemptKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const attemptsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    attemptsRef.current = 0;
    setAttemptKey(0);
    setFailed(false);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [uri]);

  const handleError = () => {
    attemptsRef.current += 1;
    if (attemptsRef.current < maxAttempts) {
      timerRef.current = setTimeout(() => {
        setAttemptKey((k) => k + 1);
      }, retryDelayMs);
    } else {
      setFailed(true);
    }
  };

  if (failed) return null;

  return (
    <Image
      key={attemptKey}
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      onError={handleError}
    />
  );
}
