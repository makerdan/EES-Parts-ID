---
name: Clerk getToken unstable reference on web
description: Clerk's getToken from useAuth() gets a new function reference on token refresh on web, causing useCallback deps loops if used directly.
---

# Clerk `getToken` Unstable Reference on Web

## The Rule
Never put Clerk's `getToken` (from `useAuth()`) directly into a `useCallback` or `useEffect` deps array. Use a stable ref instead.

**Why:** On web, Clerk rotates the `getToken` function reference whenever the token refreshes (the auth context re-renders). If `getToken` is in a `useCallback`'s deps, the callback recreates every rotation. If that callback is in a `useEffect`'s deps, the effect re-fires every rotation, calling `setApprovalStatus("loading")` → re-render → new `getToken` → infinite loop.

This manifests as:
- Preview screen "flashing" (rapid re-mounts)
- Hundreds of API requests per second (each re-mount fires inventory sync + screen-view tracking)
- Tight batches of `GET /api/inventory`, `POST /api/track/screen-view`, `GET /api/auth/status` in logs

**How to apply:**
```tsx
// BAD — getToken in deps causes re-creation on token refresh
const doApprovalCheck = useCallback(async () => {
  const token = await getToken();
}, [getToken]);

// GOOD — use a stable ref updated via useEffect
const getTokenRef = useRef(getToken);
useEffect(() => { getTokenRef.current = getToken; }, [getToken]);

const doApprovalCheck = useCallback(async () => {
  const token = await getTokenRef.current();  // stable
}, []);  // no getToken in deps
```

The pattern is already present in AppContext.tsx (`getTokenRef`); all uses of `getToken` inside callbacks should go through the ref.
