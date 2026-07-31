---
name: parts-id e2e via Clerk approval gate
description: How to run browser e2e tests against the parts-id app, which gates all signed-in users behind a DB approval status.
---

**Rule:** Signed-in users are only admitted when their row in the `users` table (key: `clerk_user_id`, no `id` column) has `status='approved'`. A fresh Clerk sign-in auto-creates the row with `status='pending'` and every API call returns 403 `{code:"pending"}` → the app shows an "Account Pending Approval" screen instead of any tab. The gate lives in the api-server app-auth middleware; `/api/floor-plan/svg|meta|tiles` are public.

**How to run an e2e test:**
1. Create a throwaway user via the Clerk backend API (`POST api.clerk.com/v1/users` with `$CLERK_SECRET_KEY`, email like `something+clerk_test@example.com`, `skip_password_checks`), then `PATCH /v1/email_addresses/{id}` with `{"verified":true}`.
2. The testing subagent signs in *programmatically* (Clerk claim override — say so explicitly in the task; do not script the custom sign-in form). Give the real password only as fallback.
3. Have the tester hit the app once (creates the pending row), or pre-insert; then `UPDATE users SET status='approved' WHERE clerk_user_id='...'` on the dev DB and send the tester a follow-up.
4. Clean up: `DELETE FROM users WHERE clerk_user_id='...'` + `DELETE api.clerk.com/v1/users/{id}`.

**Why:** A tester without approval reports "unable" with zero SVG/DOM signal, which looks like the feature is broken when it is only gated.
