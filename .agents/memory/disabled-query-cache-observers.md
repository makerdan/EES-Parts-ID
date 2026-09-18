---
name: Disabled query cache observers
description: React Query screens that display mutation-owned data through an app-owned disabled cache entry
---

When a screen uses an app-owned React Query entry only as a handoff for mutation results, do not assume a disabled `useQuery` observer alone will reliably drive the visible list after another screen patches that entry. Subscribe to the QueryCache for the stable key and read the entry with `getQueryData` when deriving UI state.

**Why:** The Search-to-edit regression showed the QueryClient entry was correctly patched while a disabled query-derived render could remain on the pre-edit card in the React Native test/runtime path.

**How to apply:** Keep the cache entry as the shared source of truth, but add a narrowly filtered QueryCache subscription for cross-screen writes; use the same subscription when a routed editor can update the cache while Search remains mounted.