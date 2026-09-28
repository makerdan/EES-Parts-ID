import { getAiClient } from "@workspace/integrations-gemini-ai";

/** Gemini model used for reference Q&A (web-grounded). */
const WEB_REFERENCE_MODEL = "gemini-2.5-flash";
const MAX_WEB_REFERENCE_TIMEOUT_MS = 120_000;
const configuredTimeout = process.env.REFERENCE_GEMINI_TIMEOUT_MS;
const WEB_REFERENCE_TIMEOUT_MS =
  configuredTimeout === undefined ? 30_000 : Number(configuredTimeout);
if (
  !Number.isSafeInteger(WEB_REFERENCE_TIMEOUT_MS) ||
  WEB_REFERENCE_TIMEOUT_MS < 1 ||
  WEB_REFERENCE_TIMEOUT_MS > MAX_WEB_REFERENCE_TIMEOUT_MS
) {
  throw new Error(
    `REFERENCE_GEMINI_TIMEOUT_MS must be an integer between 1 and ${MAX_WEB_REFERENCE_TIMEOUT_MS}`,
  );
}

export class GeminiRequestTimeoutError extends Error {
  constructor() {
    super("Reference Gemini request timed out");
    this.name = "GeminiRequestTimeoutError";
  }
}

class GeminiRequestAbortedError extends Error {
  constructor() {
    super("Reference Gemini request was cancelled");
    this.name = "GeminiRequestAbortedError";
  }
}

async function generateContentWithDeadline<T extends { text?: string | null | undefined }>(
  generate: (signal: AbortSignal) => Promise<T>,
  requestSignal?: AbortSignal,
): Promise<T> {
  if (requestSignal?.aborted) {
    throw new GeminiRequestAbortedError();
  }

  const timeoutController = new AbortController();
  const providerSignal = AbortSignal.any(
    requestSignal
      ? [requestSignal, timeoutController.signal]
      : [timeoutController.signal],
  );

  let timeout: NodeJS.Timeout | undefined;
  let onRequestAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new GeminiRequestTimeoutError();
      timeoutController.abort(error);
      reject(error);
    }, WEB_REFERENCE_TIMEOUT_MS);
    timeout.unref();
  });

  const requestAbortPromise = requestSignal
    ? new Promise<never>((_resolve, reject) => {
        onRequestAbort = () => reject(new GeminiRequestAbortedError());
        requestSignal.addEventListener("abort", onRequestAbort, { once: true });
        if (requestSignal.aborted) {
          onRequestAbort();
        }
      })
    : undefined;

  try {
    const providerPromise = generate(providerSignal);
    const pending: Array<Promise<T>> = [providerPromise, timeoutPromise];
    if (requestAbortPromise) {
      pending.push(requestAbortPromise);
    }
    return await Promise.race(pending);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (requestSignal && onRequestAbort) {
      requestSignal.removeEventListener("abort", onRequestAbort);
    }
  }
}

/**
 * Call Gemini-2.5-Flash via Replit AI Integrations for a reference answer.
 *
 * Sends a single-turn prompt consisting of a system instruction and the user
 * question. Returns the model's full text response.
 */
export async function callGemini(
  systemInstruction: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await generateContentWithDeadline(
    (providerSignal) =>
      getAiClient().models.generateContent(
        {
          model: WEB_REFERENCE_MODEL,
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          config: {
            systemInstruction,
            maxOutputTokens: 8192,
            abortSignal: providerSignal,
          },
        },
      ),
    signal,
  );
  return response.text ?? "";
}

/**
 * Call Gemini-2.5-Flash with a multi-turn conversation history.
 *
 * Prior turns are interleaved as alternating user/model roles. The current
 * user message is appended at the end. Returns the model's full text response.
 */
export async function callGeminiWithHistory(
  systemInstruction: string,
  history: Array<{ q: string; a: string }>,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const priorTurns = history.flatMap((turn) => [
    { role: "user" as const, parts: [{ text: turn.q }] },
    { role: "model" as const, parts: [{ text: turn.a }] },
  ]);

  const response = await generateContentWithDeadline(
    (providerSignal) =>
      getAiClient().models.generateContent(
        {
          model: WEB_REFERENCE_MODEL,
          contents: [...priorTurns, { role: "user", parts: [{ text: userMessage }] }],
          config: {
            systemInstruction,
            maxOutputTokens: 8192,
            abortSignal: providerSignal,
          },
        },
      ),
    signal,
  );
  return response.text ?? "";
}
