---
name: ESLint import sort order
description: simple-import-sort may order workspace packages before other external packages and sort imported specifiers by its own canonical order.
---

Repository lint can reject imports that are valid TypeScript when external package groups or mixed type/value specifiers are not in the rule's autofix order.

**Why:** The full validation tier stops at lint, so a changed file can appear locally correct while the repository's exact import sorter still rejects it.

**How to apply:** Use ESLint's `--fix-dry-run` output to inspect the canonical rewrite, then apply only that import diff rather than guessing at grouping or specifier order.