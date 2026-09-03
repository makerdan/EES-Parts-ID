import { HELP_ERROR_CODE, type HelpErrorCode, isHelpErrorCode } from "@workspace/api-zod";

import { API_BASE } from "@/utils/apiBase";
import { fetchWithAuth } from "@/utils/appAuth";
import type { HelpAudience, HelpRecord, HelpResponse } from "@/utils/helpStorage";

export { HELP_ERROR_CODES, type HelpErrorCode } from "@workspace/api-zod";

export class HelpApiError extends Error {
  constructor(
    public readonly code: HelpErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HelpApiError";
  }
}

function isHelpResponse(value: unknown, audience: HelpAudience): value is HelpResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Partial<HelpResponse>;
  return (
    typeof response.schemaVersion === "string" &&
    typeof response.contentVersion === "string" &&
    response.audience === audience &&
    Array.isArray(response.records) &&
    response.records.length > 0 &&
    response.records.every((record) => {
      const item = record as Partial<HelpRecord>;
      return item.audience === audience && typeof item.title === "string" && typeof item.workflow === "string";
    })
  );
}

async function readError(res: Response): Promise<HelpApiError> {
  const data = await res.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  const code = isHelpErrorCode(data.code) ? data.code : undefined;
  const message = typeof data.error === "string" ? data.error : `Help request failed (${res.status})`;
  if (code) return new HelpApiError(code, message, res.status);
  if (res.status === 429) return new HelpApiError(HELP_ERROR_CODE.PROVIDER_RATE_LIMITED, message, res.status);
  if (res.status === 401 || res.status === 403) {
    return new HelpApiError(HELP_ERROR_CODE.AUTHORIZATION_UNAVAILABLE, message, res.status);
  }
  return new HelpApiError(HELP_ERROR_CODE.PROVIDER_UNAVAILABLE, message, res.status);
}

export async function fetchHelpRecords(
  audience: HelpAudience,
  signal?: AbortSignal,
): Promise<HelpResponse> {
  const res = await fetchWithAuth(`${API_BASE}/help${audience === "admin" ? "/admin" : ""}`, {
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await readError(res);
  const data: unknown = await res.json();
  if (!isHelpResponse(data, audience)) {
    throw new HelpApiError(HELP_ERROR_CODE.PROVIDER_UNAVAILABLE, "Help content was not in the expected format.", res.status);
  }
  return data;
}

export async function askHelpQuestion(
  question: string,
  history: Array<{ q: string; a: string }>,
  signal?: AbortSignal,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithAuth(
      `${API_BASE}/help/ask`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
        ...(signal ? { signal } : {}),
      },
      10_000,
    );
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || /timed? ?out|timeout/i.test(error.message))) {
      throw new HelpApiError(HELP_ERROR_CODE.TIMEOUT, "The Help assistant timed out.", 504);
    }
    throw new HelpApiError(HELP_ERROR_CODE.PROVIDER_UNAVAILABLE, "The Help assistant is unavailable right now.");
  }
  if (!res.ok) throw await readError(res);
  const data = await res.json().catch(() => null) as { answer?: unknown; code?: unknown } | null;
  if (!data || typeof data.answer !== "string" || !data.answer.trim()) {
    throw new HelpApiError(HELP_ERROR_CODE.PROVIDER_UNAVAILABLE, "The Help assistant returned an empty answer.", res.status);
  }
  return data.answer;
}