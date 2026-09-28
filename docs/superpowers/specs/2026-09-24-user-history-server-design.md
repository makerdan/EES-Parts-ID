# Per-user search and scan history

## Problem

Search-query, viewed-item, and barcode-scan histories are stored under shared
device keys. A different account signing in on the same installation can read
the prior account's history.

## Approved design

Store the three history collections in one database row per Clerk user. The
server obtains the owner from the authenticated request; clients cannot select
or submit a different owner. The row contains separate JSONB arrays for query
history, viewed-item history, and scan history, plus an update timestamp. Its
user ID references the app's user row with delete cascade.

Expose an authenticated read operation and partial updates for the three
collections. Validate the collection shapes and preserve their existing bounds:
10 queries, 10 viewed items, and 50 scans. An empty array clears that collection.
The client no longer reads or writes history to device-wide storage.

The client clears history state when the Clerk identity changes or signs out.
Every asynchronous load or write captures an account generation and may publish
state only while that generation and user ID are still current. Existing
unscoped query, viewed-item, and scan keys are deleted without migration. Shared
inventory and floor-plan cache keys are not changed or cleared.

## Error handling

Malformed payloads receive a client error without changing stored history.
Authentication continues through the API's existing verified Clerk middleware.
The client treats a failed history read as empty for display, but does not treat
that result as permission to overwrite server history. Update failures leave the
server's prior history intact and do not publish results for a stale account.
Account deletion removes its history row through the database relationship.

## Regression hardening

- API tests create or update history as two different authenticated users and
  prove that each sees only their own record.
- API tests reject invalid shapes and arrays above their established limits.
- Client tests switch identity while a prior user's history read is unresolved,
  then prove the late response cannot enter the new account's visible state.
- Tests verify that legacy unscoped history is discarded and shared inventory
  and floor-plan caches are not included in history cleanup.