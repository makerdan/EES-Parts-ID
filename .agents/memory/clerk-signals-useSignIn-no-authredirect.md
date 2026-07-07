---
name: Clerk signals useSignIn lacks authenticateWithRedirect
description: In @clerk/react 6.11.3 / @clerk/shared 4.23.0 the signals useSignIn returns a future resource with no authenticateWithRedirect; use useClerk().client.signIn for classic web OAuth redirect.
---

In this Clerk stack (@clerk/expo re-exporting @clerk/react 6.11.3, backed by
@clerk/shared 4.23.0), `useSignIn()` returns the **new signals API**:
`{ signIn, errors, fetchStatus }` — NO `isLoaded`, and `signIn` is a
`SignInFutureResource` that has NO `authenticateWithRedirect` method (its SSO
path is `SignInFutureSSOParams`-based). Older classic `authenticateWithRedirect`
types only exist in @clerk/shared **3.47.7**.

**Rule:** For a web full-page social OAuth redirect, do NOT use `useSignIn()`.
Reach the classic resource through the Clerk instance:
`useClerk().client.signIn.authenticateWithRedirect({ strategy, redirectUrl, redirectUrlComplete })`.
`useClerk()` is typed `LoadedClerk` (`client: ClientResource`, `.signIn: SignInResource`
classic, which HAS `authenticateWithRedirect`), so it passes both typecheck and
runtime. Guard `clerk.client?.signIn` before calling. Finalize on the callback
route with `useClerk().handleRedirectCallback(...)`.

**Why:** `useSignIn().signIn.authenticateWithRedirect` breaks at BOTH type-check
and runtime in this version — the signals future resource simply doesn't expose it.

**How to apply:** Any web (Platform.OS === "web") custom social OAuth button in
this repo. Native keeps `useSSO().startSSOFlow`. If Clerk is upgraded, re-verify
which shared version resolves and whether the signals API gained an SSO redirect.
