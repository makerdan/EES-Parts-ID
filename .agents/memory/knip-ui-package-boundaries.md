---
name: Knip UI package boundaries
description: Knip configuration for Vite UI packages with generated component registries and CSS-only dependencies.
---

For Vite UI packages, make dynamically discovered component directories, test setup files, and runtime workers explicit Knip entrypoints. Record dependencies used only by CSS imports in `ignoreDependencies`; do not broadly ignore source files or relax ESLint unused-variable rules.

**Why:** Static analysis cannot reliably follow generated runtime import maps or CSS `@import` statements, so treating those boundaries as ordinary unused code creates false positives and encourages overly broad ignores.

**How to apply:** When adding a package-level Knip check, identify all runtime and test entrypoints first, use narrow CSS-only dependency exceptions, and keep the check attached to the package lint command.