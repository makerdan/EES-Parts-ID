/**
 * Three-layer chip answer resolution used by the Reference Modal.
 *
 * Layer 1 — in-memory cache   : return immediately, zero network calls
 *                               (skipped if the entry is older than MAX_AGE_MS)
 * Layer 2 — DB cache (GET)    : return server-cached answer, no AI call
 * Layer 3 — AI fallback (POST): call AI, write result back to DB + cache
 *
 * Both functions accept the caller-owned cache Map and apiBase string so
 * they are pure and fully testable without a mounted component.
 */

import { fetchWithAuth } from "@/utils/appAuth";

/** Maximum age for an in-memory cache entry before it is considered stale. */
export const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Maximum number of entries kept in a BoundedLruMap before the oldest is evicted. */
export const MAX_CACHE_SIZE = 500;

/** Shape stored in the caller-owned cache Map. */
export interface CacheEntry {
  answer: string;
  /** Unix timestamp (ms) when this entry was written into the cache. */
  fetchedAt: number;
}

/**
 * A Map that evicts the least-recently-used entry once `maxSize` is reached.
 *
 * JS Map preserves insertion order. LRU is maintained by deleting and
 * re-inserting a key on every write (set), which moves it to the tail.
 * The head (first entry in iteration order) is therefore always the LRU
 * candidate and is evicted when the map is full.
 *
 * Extends Map so it is a drop-in replacement wherever Map<K, V> is expected.
 */
export class BoundedLruMap<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number = MAX_CACHE_SIZE) {
    super();
    this.maxSize = maxSize;
  }

  override set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxSize) {
      const lruKey = this.keys().next().value as K;
      this.delete(lruKey);
    }
    super.set(key, value);
    return this;
  }
}

export async function fetchChipAnswer(
  label: string,
  chipQuestion: string,
  cache: Map<string, CacheEntry>,
  apiBase: string,
): Promise<string> {
  const entry = cache.get(label);
  if (entry !== undefined) {
    if (Date.now() - entry.fetchedAt <= MAX_AGE_MS) {
      return entry.answer;
    }
    // Entry is stale — remove it and fall through to Layer 2/3.
    cache.delete(label);
  }

  try {
    const res = await fetchWithAuth(
      `${apiBase}/reference/quick-lookups/${encodeURIComponent(label)}`,
    );
    if (res.ok) {
      const data: { answer: string } = await res.json();
      cache.set(label, { answer: data.answer, fetchedAt: Date.now() });
      return data.answer;
    }
  } catch {
    // network error — fall through to AI
  }

  const res = await fetchWithAuth(
    `${apiBase}/reference/quick-lookups/${encodeURIComponent(label)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: chipQuestion }),
    },
  );
  if (!res.ok) throw new Error("AI fallback failed");
  const data: { answer: string } = await res.json();
  cache.set(label, { answer: data.answer, fetchedAt: Date.now() });
  return data.answer;
}

export async function prefetchQuickLookups(
  cache: Map<string, CacheEntry>,
  apiBase: string,
): Promise<void> {
  try {
    const res = await fetchWithAuth(`${apiBase}/reference/quick-lookups`);
    if (!res.ok) return;
    const rows: Array<{ label: string; answer: string }> = await res.json();
    const now = Date.now();
    for (const row of rows) {
      cache.set(row.label, { answer: row.answer, fetchedAt: now });
    }
  } catch {
    // Non-fatal — cache will be populated on demand
  }
}
