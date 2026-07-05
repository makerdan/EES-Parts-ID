import OpenAI from "openai";

let _poeClient: OpenAI | null = null;

export function getPoeClient(): OpenAI {
  if (!_poeClient) {
    if (!process.env.POE_API_KEY2) {
      throw new Error(
        "POE_API_KEY2 must be set. Did you forget to add the Poe API key secret?",
      );
    }
    _poeClient = new OpenAI({
      apiKey: process.env.POE_API_KEY2,
      baseURL: "https://api.poe.com/v1",
    });
  }
  return _poeClient;
}

/**
 * Returns true if the error is a Poe authentication or authorization failure
 * (invalid/revoked key, bot access denied). These errors will not resolve on
 * retry — the operator must fix the API key or subscription.
 */
export function isPoeAuthError(err: unknown): boolean {
  return (
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError
  );
}

/**
 * Returns true if the error is likely transient (rate limit, server error,
 * network timeout) and worth retrying after a backoff.
 */
export function isPoeTransientError(err: unknown): boolean {
  return (
    err instanceof OpenAI.RateLimitError ||
    err instanceof OpenAI.InternalServerError ||
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  );
}

/**
 * Returns a human-readable message for a known Poe API error,
 * or null if the error is not a recognised Poe API error.
 */
export function poeErrorMessage(err: unknown): string | null {
  if (err instanceof OpenAI.AuthenticationError) {
    return "Poe API key is invalid or has been revoked. Check the POE_API_KEY2 secret.";
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return "Poe API key does not have access to the requested bot. Check your Poe subscription or bot permissions.";
  }
  if (err instanceof OpenAI.RateLimitError) {
    return "Poe API rate limit or quota exceeded. Try again later or reduce concurrency.";
  }
  if (err instanceof OpenAI.NotFoundError) {
    return "Poe bot not found. Check the model name is correct.";
  }
  if (err instanceof OpenAI.APIError) {
    return `Poe API error (HTTP ${err.status}): ${err.message}`;
  }
  return null;
}
