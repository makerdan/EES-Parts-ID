/**
 * inventoryIndex.ts — REMOVED in Stage 4 (index-time synonym expansion).
 *
 * The Fuse.js in-memory index has been replaced by trigram similarity
 * against the `inventory.search_tokens` column, which is pre-populated
 * at enrichment time by `buildSearchTokens()`. This file is kept as a
 * stub so any stale import references produce a clear TS error rather
 * than a silent module-not-found at runtime.
 *
 * Nothing in the server imports this file anymore.
 */
export {};
