/**
 * Poe bot caller using the OpenAI-compatible API at https://api.poe.com/v1
 *
 * Key: process.env.POE_API_KEY2
 * Endpoint: POST https://api.poe.com/v1/chat/completions  (NOT /bot/)
 * Model names are Poe display names, e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6"
 *
 * Reference: https://developer.poe.com/server-bots/accessing-other-bots-on-poe
 */

import OpenAI from "openai";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env["POE_API_KEY2"];
    if (!apiKey) throw new Error("POE_API_KEY2 is not set");
    _client = new OpenAI({ apiKey, baseURL: "https://api.poe.com/v1" });
  }
  return _client;
}

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
  return (
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError
  );
}

export function isPoeCallTransientError(err: unknown): boolean {
  return (
    err instanceof OpenAI.RateLimitError ||
    err instanceof OpenAI.InternalServerError ||
    err instanceof OpenAI.APIConnectionError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  );
}

/**
 * Call a Poe bot and return the full text response.
 *
 * @param botName           - Poe display-name (e.g. "GPT-4o-Mini", "Claude-Sonnet-4.6").
 * @param systemInstruction - System-prompt text.
 * @param userMessage       - User turn content.
 */
export async function callPoeBot(
  botName: string,
  systemInstruction: string,
  userMessage: string,
): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: botName,
    max_completion_tokens: 512,
    messages: [
      { role: "system", content: systemInstruction },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}
