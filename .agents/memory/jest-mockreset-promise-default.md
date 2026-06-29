---
name: Jest mockReset needs default Promise after reset
description: mockReset() strips all implementations; mocks used in .then() chains crash unless a default mockResolvedValue is re-established.
---

## Rule
After `mockFn.mockReset()` in a `beforeEach`, immediately call `mockFn.mockResolvedValue(null)` (or the appropriate default) if the mock is used inside a `.then()` call anywhere in the component under test.

**Why:** `mockReset()` removes all implementations, leaving the mock returning `undefined`. If component code calls `AsyncStorage.getItem(...).then(...)` and the mock returns `undefined`, `.then()` throws `TypeError: Cannot read properties of undefined (reading 'then')`. Individual suites that call `mockResolvedValue(specificValue)` before mounting override the default and are unaffected — but suites that don't explicitly configure the mock (e.g. a cold-cache suite that doesn't care about the result) would crash.

**How to apply:** In the outer `beforeEach` of any test file that mocks an async API (AsyncStorage, fetch, etc.):
1. Call `mockReset()` to clear call history.
2. Immediately follow with `mockResolvedValue(null)` (or `mockResolvedValue(undefined)`) as a safe default.
3. Individual suites override with their specific return value in their own `beforeEach` or at the top of each test.
