---
name: Patch published packages instead of vendoring build output
description: Avoid incomplete local dependency overrides when a repository ignores compiled distribution directories.
---

When hardening a published dependency whose runtime ships as compiled output, prefer
pnpm `patchedDependencies` against an exact registry version over copying the package
into a local directory override.

**Why:** A repo-wide `dist/` ignore can silently exclude the package entry point while
still committing its `package.json`, producing an install that looks valid in metadata
but fails at runtime. A pinned registry tarball provides the complete package first,
then pnpm applies and hashes only the intentional hardening diff.

**How to apply:** Pin the same exact version in direct dependencies and every override
source, keep the generated patch under `patches/`, regenerate the frozen lockfile, and
test both declared entry-point existence and runtime loading after a frozen install.