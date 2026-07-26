# Pre-existing Failure Handling in Task Plans

**Date:** 2026-07-26
**Status:** Approved

---

## Problem

Task agents frequently encounter test and validation failures that existed on `main` before
their changes touched anything. Because they cannot distinguish pre-existing failures from
regressions they introduced, they:

1. Spend significant time investigating the failure before concluding it is unrelated
2. Attempt to fix it, touching code outside their task scope — sometimes introducing new bugs
3. Fail to mark the task complete because the gate still shows red

The main offenders are **flaky tests** (especially in the api-server suite) and intermittent
**TypeScript typecheck drift**. TypeScript drift is handled separately via dedicated audit
tasks; this design focuses on flaky and intermittent test failures.

---

## Solution: Pre-existing failures section in every task plan

A documentation convention, not a new system. Two additions to the standard plan template
give agents the information and authority they need to finish cleanly.

---

## Plan section format

Every task plan includes a **"Pre-existing failures to ignore"** section, placed after
"Steps" and before "Relevant files."

**When pre-existing failures are known:**

~~~markdown
## Pre-existing failures to ignore
These failures exist on `main` before this task starts. Do not investigate or fix them.

- **api-server / [suite name]** — [one-line description of the failure and why it is pre-existing]
- *(additional entries as discovered during planning)*

**Flaky-test rule:** If a test not listed above fails, retry it 3× before concluding it is
a regression you caused. Only treat a consistent 3/3 failure as your responsibility.

If the only remaining failures are those listed above (or consistent flaky tests that fail
across 3 retries regardless of your changes), you are cleared to mark this task complete.
Do not attempt further validation fixes.
~~~

**When no pre-existing failures are found:**

~~~markdown
## Pre-existing failures to ignore
None known at plan time. Treat every failure as a potential regression.

**Flaky-test rule:** If a test fails, retry it 3× before concluding it is a regression
you caused. Only treat a consistent 3/3 failure as your responsibility.
~~~

The section is always present so agents can rely on it unconditionally.

---

## Planner discovery process

Before writing any plan, the planner performs a lightweight discovery step:

1. **Scan recent merged task descriptions** for mentions of "pre-existing", "known failure",
   "flaky", or named suites — cheap and catches the most common offenders.
2. **Check persistent memory** (`.agents/memory/MEMORY.md`) for documented flaky patterns —
   several are already recorded (e.g. `reverseVendorMap row-order flake`,
   `vendor-map heap-order tests`, `concurrent effects consume fetchWithAuth mocks out of order`).
3. **Spot-run the api-server suite** when the task touches api-server code — makes the
   section accurate rather than approximate.
4. **Skip typecheck discovery** — typecheck drift is handled by dedicated audit tasks on demand.

---

## Completion permission

The section's closing lines serve a second purpose beyond information: they give the agent
explicit authority to stop. Without this, an agent that intellectually understands which
failures to ignore still hesitates at the finish line because it sees red.

The phrase **"Do not attempt further validation fixes"** is deliberate:
- "Validation fixes" is precise — it targets the repair-the-test loop, not all work
- It does not tell the agent to abandon implementation work, only to stop chasing failures
  it did not cause
- It is unambiguous enough for an agent to act on without second-guessing

---

## What this does not fix (intentionally out of scope)

- **The gate still shows red** from pre-existing failures. This is accepted residual noise.
  A dedicated typecheck audit task can clear accumulated drift when needed.
- **TypeScript errors** — excluded by agreement; handled via manual audit tasks.
- **Failures that appear after plan-write** — if a new intermittent failure appears between
  planning and execution, the 3× retry rule provides a reasonable fallback. If it passes
  on retry, it was flaky; if it fails 3/3, the agent owns it.
- **Automated baseline diffing** — no tooling is built. If the volume of pre-existing
  failures grows large enough that manual discovery is impractical, a project-wide
  `known-failures.json` (updated at plan time) is the natural next step.

---

## Regression hardening

The convention itself is the guard: the "Pre-existing failures to ignore" section must be
present in every plan — even if empty — so agents always have a consistent signal to look
for. If a future plan omits the section, the agent defaults to treating all failures as
potential regressions (the safe direction), so the failure mode is conservative rather
than destructive.

A future task-triage or template-audit pass can verify that merged plans contain the
section as a spot-check on compliance.

---

## Success criteria

- Task agents stop modifying files outside their scope in order to fix pre-existing failures
- Tasks that touch api-server code complete without the agent looping on known-flaky suite
  failures
- Plans contain a "Pre-existing failures to ignore" section that accurately reflects the
  state of `main` at plan-write time
