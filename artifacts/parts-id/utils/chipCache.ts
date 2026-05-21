/**
 * Three-layer chip answer resolution used by the Reference Modal.
 *
 * Layer 1 — in-memory cache   : return immediately, zero network calls
 * Layer 2 — DB cache (GET)    : return server-cached answer, no AI call
 * Layer 3 — AI fallback (POST): call AI, write result back to DB + cache
 *
 * Both functions accept the caller-owned cache Map and apiBase string so
 * they are pure and fully testable without a mounted component.
 */

export async function fetchChipAnswer(
  label: string,
  chipQuestion: string,
  cache: Map<string, string>,
  apiBase: string,
): Promise<string> {
  const cached = cache.get(label);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(
      `${apiBase}/reference/quick-lookups/${encodeURIComponent(label)}`,
    );
    if (res.ok) {
      const data: { answer: string } = await res.json();
      cache.set(label, data.answer);
      return data.answer;
    }
  } catch {
    // network error — fall through to AI
  }

  const res = await fetch(
    `${apiBase}/reference/quick-lookups/${encodeURIComponent(label)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: chipQuestion }),
    },
  );
  if (!res.ok) throw new Error("AI fallback failed");
  const data: { answer: string } = await res.json();
  cache.set(label, data.answer);
  return data.answer;
}

export async function prefetchQuickLookups(
  cache: Map<string, string>,
  apiBase: string,
): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/reference/quick-lookups`);
    if (!res.ok) return;
    const rows: { label: string; answer: string }[] = await res.json();
    for (const row of rows) {
      cache.set(row.label, row.answer);
    }
  } catch {
    // Non-fatal — cache will be populated on demand
  }
}
