---
name: pnpm lockfile drift on main
description: Why any pnpm install/remove currently rewrites ~12k lockfile lines, and how to recover from an accidental rewrite.
---

**Rule:** `pnpm-lock.yaml` on main is drifted from the workspace `package.json`s: ANY `pnpm install`, `pnpm add`, or `pnpm remove` triggers a full re-resolution that rewrites ~12k lines, moving/dropping entries belonging to *other* importers. Do not add or remove dependencies until the lockfile is reconciled on main (a follow-up task exists for this).

**Why:** Removing an unused dep (dompurify) during the map-fix task produced a monster lockfile diff that would have polluted the task merge; had to `git checkout -- pnpm-lock.yaml package.json` and re-run `pnpm install` to restore.

**How to apply:** If a dep change is unavoidable, expect the huge diff and isolate it in its own commit. If an install rewrites the lockfile accidentally: revert `pnpm-lock.yaml` (and any touched `package.json`) to HEAD, then `pnpm install` to re-link against the committed lockfile. Reconciliation = getting `pnpm install --lockfile-only` to produce an empty diff on main, then dep changes become surgical again.
