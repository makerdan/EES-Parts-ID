---
name: CI parity revision refresh
description: How a committed CI parity report identifies the revision it actually analyzed.
---

The CI parity report identifies the analyzed parent revision when the report itself is the latest commit. An uncommitted report refresh analyzes the checked-out HEAD; a later unrelated commit makes it stale again.

**Why:** A report commit cannot name its own hash before the commit exists. Treating its analyzed parent as stale makes a correct committed report fail immediately. Treating every ancestor as valid would hide unrelated later revisions.

**How to apply:** When a parity revision check fails, determine whether the report is uncommitted, changed by the current commit, or followed by unrelated commits before refreshing its evidence and provenance. Do not relabel old provider observations as current.

An older committed report can name a revision that is not the parent of its last report-changing commit; the recorded object may not even be present locally. In that case treat its provenance as **unverified**, not as a verified stale snapshot. Isolate it from current-revision assertions; a metadata-only refresh must refuse to relabel it.

**Why:** A later unrelated change must not block unrelated checks, but accepting historical metadata solely because it looks like a hash would promote unverified provider observations.

**How to apply:** Distinguish exact current matches, historically verified stale reports, and unverified old reports. None of the latter two can authorize current CI parity claims.