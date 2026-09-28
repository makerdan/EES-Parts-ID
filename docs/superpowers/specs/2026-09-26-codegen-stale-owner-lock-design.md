# Codegen stale-owner lock test design

## Problem and scope

The API-spec stale-owner test fails consistently because it expects an owner whose
stale lease was reclaimed to exit successfully. The serial-lock wrapper instead
terminates work that no longer has verified ownership and exits unsuccessfully.
Keep that safety behavior. Repair only the test unless focused evidence reveals
an actual lock-ownership defect. Do not change the canonical setup fixture,
production validation budgets, or tier membership.

## Approach

Use isolated temporary lock and queue paths as the existing test does. Have the
first worker remain alive until it is reclaimed, rather than finishing after a
short timer. The successor writes a ready marker once it owns the replacement
lock, then waits for a test-controlled release marker. After the first wrapper
has exited, assert that it failed because ownership was lost and that the
successor's distinct token and lock file remain intact. Release the successor,
assert it exits successfully, and confirm the lock is removed.

Marker-based synchronization replaces timing assumptions about when the old
worker completes. The test retains bounded waits and releases waiting workers
in cleanup even when an assertion fails. The production codegen and locking
paths remain unchanged.

## Alternatives considered

- Increasing the fixture delays alone might reduce failures but would keep the
  race-dependent assertion and could hide a broken release path.
- Changing production lock-release behavior before proving a defect would risk
  allowing work to continue without verified ownership.

## Verification and regression guard

Run the single stale-owner test repeatedly, then the API-spec test file. The
regression assertion is that the first owner cannot remove the successor's
tokenized lock; the successor can still complete and release its own lock. Run
the assigned task's `test-fast` completion command without escalating its tier.