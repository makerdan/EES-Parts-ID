/**
 * Native Poe bot caller using Poe's own SSE query protocol.
 *
 * WHY NOT the OpenAI SDK:
 * The OpenAI SDK with baseURL "https://api.poe.com/bot/" always appends
 * "/chat/completions" → the URL becomes https://api.poe.com/bot/chat/completions,
 * which Poe does NOT serve. Poe's endpoint is POST /bot/{bot_name} with its
 * own SSE envelope — completely different from OpenAI's chat/completions schema.
 */

import { randomUUID } from "crypto";

export class PoeHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Poe API HTTP ${status}: ${statusText}`);
    this.name = "PoeHttpError";
    this.status = status;
  }
}

export class PoeBotError extends Error {
  readonly allowRetry: boolean;
  constructor(detail: string, allowRetry: boolean) {
    super(`Poe bot error: ${detail}`);
    this.name = "PoeBotError";
    this.allowRetry = allowRetry;
  }
}

export function isPoeCallAuthError(err: unknown): boolean {
  return err instanceof PoeHttpError && (err.status === 401 || err.status === 403);
}

export function isPoeCallTransientError(err: unknown): boolean {
  if (err instanceof PoeHttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof PoeBotError) return err.allowRetry;
  return false;
}

/**
 * Call a Poe bot and return the full concatenated text response.
 *
 * @param botName           - Lowercase Poe bot slug (e.g. "gpt-5-mini", "gpt-4o").
 * @param systemInstruction - System-prompt text (injected as "system" role).
 * @param userMessage       - User turn content.
 */
export async function callPoeBot(
  botName: string,
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  const apiKey = process.env["POE_API_KEY2"];
  if (!apiKey) throw new Error("POE_API_KEY2 is not set");

  const nowMicros = Date.now() * 1000;
  const messageId = randomUUID();

  const body = {
    version: "1.0",
    type: "query",
    query: [
      {
        role: "system",
        content: systemInstruction,
        content_type: "text/plain",
        timestamp: nowMicros,
        message_id: randomUUID(),
        attachments: [],
      },
      {
        role: "user",
        content: userMessage,
        content_type: "text/plain",
        timestamp: nowMicros + 1,
        message_id: messageId,
        attachments: [],
      },
    ],
    user_id: "",
    conversation_id: randomUUID(),
    message_id: messageId,
  };

  const response = await fetch(`https://api.poe.com/bot/${botName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new PoeHttpError(response.status, response.statusText);
  }

  const rawText = await response.text();
  let result = "";
  let currentEvent = "";

  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event: ")) {
      currentEvent = trimmed.slice(7).trim();
    } else if (trimmed.startsWith("data: ")) {
      const dataStr = trimmed.slice(6);
      if (currentEvent === "text") {
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>;
          if (typeof data["text"] === "string") result += data["text"] as string;
        } catch {
          /* skip malformed data lines */
        }
      } else if (currentEvent === "error") {
        let allowRetry = false;
        try {
          const data = JSON.parse(dataStr) as Record<string, unknown>;
          allowRetry = Boolean(data["allow_retry"]);
        } catch {
          /* ignore */
        }
        throw new PoeBotError(dataStr, allowRetry);
      }
      currentEvent = "";
    }
  }

  return result.trim();
}
