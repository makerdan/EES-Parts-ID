---
name: Clerk role-based admin (parts-id mobile)
description: How admin authority works in the parts-id Expo app after dropping the shared-password/admin-token flow, and two field names kept for compat.
---

Admin authority in the `artifacts/parts-id` mobile app is **role-based via Clerk**, not a
separate admin password / HMAC admin-token. There is a single auth token source: the Clerk
session token. `GET /admin/me` returns `{ isAdmin }` and is the source of truth for gating.

**Two names kept but repurposed (do not assume they mean what they say):**
- AppContext still exposes a context field named `adminToken`, but it now holds the **Clerk
  session token** and is `null` unless the user is an admin. It is NOT a distinct admin token.
  Kept to avoid touching ~15 downstream consumers.
- `logoutAdmin` in the context no longer clears an admin token — it **re-verifies admin**
  (re-hits `GET /admin/me`). It is called on 401 responses across `app/(tabs)/upload.tsx`.

**Why:** migrating to Clerk roles while keeping the field/method names minimized churn across
many call sites. A future reader seeing `adminToken` or `logoutAdmin` would otherwise assume the
old password/token model still exists.

**How to apply:** gate admin UI on the boolean `isAdmin` (from context), not on presence of
`adminToken`. The auth getter registered with `setAuthTokenGetter` is Clerk-only
(`getTokenRef.current()`); never reintroduce admin-token precedence. `shouldRedirectNonAdmin`
takes `(isLoading, isAdmin: boolean)` — pass the boolean, not a token string.
