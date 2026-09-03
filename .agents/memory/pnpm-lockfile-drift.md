---
name: pnpm lockfile drift on main
description: Why any pnpm install/remove currently rewrites ~12k lockfile lines, and how to recover from an accidental rewrite.
---

**Rule:** `pnpm-lock.yaml` on main is drifted from the workspace `package.json`s: ANY `pnpm install`, `pnpm add`, or `pnpm remove` triggers a full re-resolution that rewrites ~12k lines, moving/dropping entries belonging to *other* importers. Do not add or remove dependencies until the lockfile is reconciled on main (a follow-up task exists for this).

**Why:** Removing an unused dep (dompurify) during the map-fix task produced a monster lockfile diff that would have polluted the task merge; had to `git checkout -- pnpm-lock.yaml package.json` and re-run `pnpm install` to restore.

**How to apply:** RESOLVED July 2026 — lockfile reconciled (`pnpm install --lockfile-only` now yields empty diff); dep changes are surgical again. If drift ever recurs: revert `pnpm-lock.yaml` (and touched `package.json`) to HEAD, `pnpm install` to re-link, then reconcile via `pnpm install --lockfile-only` in an isolated commit. Note: a real `pnpm add/remove` may flip the jest↔@types/node peer snapshot vs a lockfile-only run; the post-install state is the stable fixed point — verify with two consecutive `pnpm install --lockfile-only` runs producing no diff.
