---
name: jest.clearAllMocks clears ALL mock implementations including non-obvious ones
description: clearAllMocks resets every jest.fn() to return undefined; nested describe beforeEach blocks must restore all mocks an async/cold path depends on.
---

# jest.clearAllMocks clears ALL mock implementations including non-obvious ones

## The Rule
`jest.clearAllMocks()` resets **both** call counts AND implementations for every `jest.fn()` in scope — including mocks set up in `jest.mock()` factory functions. After `clearAllMocks()`, every mock returns `undefined` unless explicitly restored.

In a test file with nested `describe` blocks:
1. Outer `beforeEach` calls `clearAllMocks()` → all mocks return `undefined`
2. Outer `beforeEach` restores the mocks it knows about (warm-cache defaults)
3. Inner `beforeEach` (for the cold/async path) must restore EVERY additional mock that path needs

**Common misses when writing cold-cache / async-path tests:**
- `getIfValid` — after clear, returns `undefined`; `undefined !== null` is `true`, so the cache-miss guard passes and the function returns early (skipping `setCached`)
- `Asset.loadAsync` — after clear, returns `undefined`; destructuring `const [asset] = undefined` throws a TypeError
- `fetchWithAuth` — after clear, returns `undefined`; accessing `.ok` on `undefined` throws a TypeError

**Why:** The warm-cache path in Suites 1-3 never exercises these mocks (guards return early), so their cleared state is invisible. The cold-cache path first exercises them, revealing all the missing restorations at once.

**How to apply:** In any inner `beforeEach` for a cold/async path, explicitly call `.mockReturnValue()` or `.mockResolvedValue()` on every mock that the async chain touches — even if the mock was set up in the module-level `jest.mock()` factory.
