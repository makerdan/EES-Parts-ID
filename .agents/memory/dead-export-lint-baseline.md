---
name: Dead-export lint binary declarations
description: Library Knip checks require each package to declare binaries used by its scripts.
---

The API-spec library's `typecheck` and code-generation scripts use `tsc`, so
`typescript` must remain in that package's `devDependencies`. Knip then resolves
the binary locally and the root `lint:libs` check remains strict about real
unlisted binaries, dependencies, exports, and unresolved imports.

**Why:** Knip evaluates each library from its own package directory rather than
silently inheriting the workspace root's tool dependencies. A missing local
declaration produces an `Unlisted binaries (1) tsc package.json` failure even
when the source and artifact lint commands are otherwise clean.

**How to apply:** When adding or changing a library script that invokes a CLI,
declare that CLI in the same package's dependencies or devDependencies and
keep the dead-export runner strict; do not blanket-ignore Knip dependency
findings.