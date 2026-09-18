---
name: SearchScreen QueryClient test harness
description: SearchScreen tests must provide TanStack Query context and seed the active results cache when asserting rendered search results.
---

SearchScreen is not a standalone component in tests: it subscribes to the TanStack Query cache and reads active search results from that cache. Tests that mount it directly need a fresh `QueryClientProvider`; tests that assert result cards should seed `["searchInventory", "active"]` with the expected response before rendering.

**Why:** A cache subscription added to SearchScreen caused older direct-mount fixtures to fail before reaching their assertions, and provider-only fixes left result-rendering tests with an empty list.

**How to apply:** Use a new client per test, keep the same client across rerenders, clear it during teardown, and wrap cache writes in `act()` after the component is mounted.