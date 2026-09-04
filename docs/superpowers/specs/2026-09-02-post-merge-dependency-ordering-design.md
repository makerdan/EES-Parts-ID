# Post-Merge Dependency Ordering Design

## Problem

When `pnpm-lock.yaml` changes, `scripts/post-merge.sh` starts a frozen dependency
install in the background and immediately continues into database and API code
generation work. Those steps can therefore execute with packages from the
previous lockfile.

The observed failure upgraded Orval in the manifest and lockfile to 8.22.0 while
the installed workspace still exposed 8.5.3. Post-merge code generation ran the
old binary and then failed during the generated-library TypeScript build.

## Selected approach

Keep the existing bounded, non-interactive frozen install, but establish a hard
ordering boundary: when the lockfile changed, post-merge must wait for that
install to finish before running database migrations, code generation, or other
dependency-sensitive commands.

The install may still be launched as a background process so cleanup and timeout
handling remain centralized, but the script will collect its result immediately
before dependency-sensitive work. A failed install will stop setup with a clear
message rather than allowing later commands to run against stale packages.

This is preferred over inspecting individual installed package versions because
the lockfile is the complete dependency contract. A package-specific preflight
could miss another changed tool or transitive dependency.

## Execution flow

1. Detect whether `pnpm-lock.yaml` changed in the merged commit.
2. If it changed, start the existing `CI=true pnpm install --frozen-lockfile`
   command under its timeout and record its PID.
3. Wait for the install before database and code-generation steps.
4. Stop immediately if the install times out or fails.
5. Continue with schema handling, locked API code generation, package freshness
   checks, service health checks, and workflow reconciliation.
6. If the lockfile did not change, preserve the fast path and skip installation.

## Error handling and cleanup

- The existing exit trap continues to terminate an unfinished install after an
  interrupt or earlier failure.
- Install timeout and non-zero exit are setup failures with an actionable log
  pointer.
- The install PID is cleared after collection so later cleanup cannot target a
  reused process ID.
- Code generation remains protected by its existing serialization lock.

## Regression hardening

Extend `scripts/test-post-merge.sh` with a focused black-box ordering test. The
test will simulate a changed lockfile, hold the mocked install open until a
sentinel is written, and make mocked code generation fail if it starts before
that sentinel exists. The test therefore fails if post-merge ever resumes
dependency-sensitive work before installation completes.

Existing install timeout, cleanup, codegen, and health-check tests remain in
place.

## Validation

After implementation:

1. Run the focused post-merge test suite.
2. Synchronize installed dependencies with the frozen lockfile.
3. Confirm the installed Orval version matches the lockfile.
4. Regenerate API clients and declarations.
5. Run the configured post-merge setup and require success.

No database schema, API contract, mobile UI, or deployment behavior changes are
part of this repair.