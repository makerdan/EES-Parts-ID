/**
 * Pure helpers for parsing the Reference Q&A SSE stream.
 *
 * The server emits two kinds of frames:
 *   data: {"content":"..."}           — incremental answer chunk
 *   data: {"done":true}               — clean end-of-stream
 *   event: error\ndata: {"error":...} — terminal error frame
 *
 * These helpers are split out so they can be unit-tested without React Native.
 */

export type SseEvent =
  | { kind: "content"; content: string }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "unparseable"; raw: string };

/**
 * Parse a single complete SSE line (no trailing newline).
 * Returns null for blank lines or non-data/non-event lines we don't care about.
 */
export function parseSseLine(line: string): SseEvent | null {
  if (line.startsWith("event: error")) {
    // The accompanying data line will arrive next; signal nothing here.
    return null;
  }
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6);
  try {
    const data = JSON.parse(payload) as {
      content?: string;
      done?: boolean;
      error?: string;
    };
    if (typeof data.error === "string") {
      return { kind: "error", message: data.error };
    }
    if (data.done) return { kind: "done" };
    if (typeof data.content === "string") {
      return { kind: "content", content: data.content };
    }
    return null;
  } catch {
    return { kind: "unparseable", raw: payload };
  }
}

/**
 * Process any leftover buffered text after the stream closed.
 * If it parses cleanly, returns the event; otherwise returns an
 * `unparseable` event so callers can surface a "stream ended unexpectedly"
 * indication instead of silently dropping the tail of an answer.
 */
export function parseFinalBuffer(buffer: string): SseEvent | null {
  const trimmed = buffer.trim();
  if (!trimmed) return null;
  const event = parseSseLine(trimmed);
  if (event) return event;
  // A non-empty leftover that doesn't even start with `data: ` is also a
  // truncated tail — surface it as unparseable.
  return { kind: "unparseable", raw: trimmed };
}
