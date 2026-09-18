---
name: pnpm catalog lockfile sync churn
description: Why a no-op `pnpm update` can produce ~900-line pnpm-lock.yaml churn adding a `catalogs:` block
---

Running `pnpm install`/`pnpm update` in this repo can rewrite `pnpm-lock.yaml` with a large diff (hundreds of lines) that adds a top-level `catalogs:` section, even when no dependency version actually changes.

**Why:** `pnpm-workspace.yaml` defines a `catalog:` block, but the committed lockfile can be stale and lack the corresponding `catalogs:` entry. pnpm regenerates it to match the workspace catalog. This is a *correction*, not accidental noise.

**How to apply:** Do NOT reflexively revert this churn (a code reviewer may flag it as "unrelated lockfile noise"). First check: does `pnpm-workspace.yaml` have a `catalog:` while `git show HEAD:pnpm-lock.yaml | rg '^catalogs:'` returns nothing? If so, the new `catalogs:` block is the lockfile catching up to the workspace config — keep it. Reverting reintroduces drift and risks a future `pnpm install --frozen-lockfile` mismatch. Confirm health via typecheck/lint/tests/bundle before keeping.
