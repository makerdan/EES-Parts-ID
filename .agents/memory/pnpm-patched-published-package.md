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

Generate and validate the patch against the actual pristine package extracted by pnpm,
not a tree reconstructed from a previously patched installation.

**Why:** Reconstructed trees can contain tiny context drift, including extra blank
lines. A patch may look correct and pass runtime tests against the old installation
while failing the next clean `pnpm install`.

**How to apply:** Before accepting a patch update, check it against the pristine
registry package, synchronize its SHA-256 in the lockfile, and run
`pnpm install --frozen-lockfile` through the normal post-merge path.