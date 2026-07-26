---
name: Failure Gate
description: >-
  Apply to every task plan written and every task executed. Teaches the Planner
  how to discover and document pre-existing test failures before writing a plan,
  and teaches the Build agent how to recognise, classify, and safely ignore them
  during execution — without wasting time on failures it did not cause.
---

# Failure Gate

This skill governs two moments in every task lifecycle:

- **Plan-time** — the Planner discovers known failures and documents them in the plan
- **Execute-time** — the Build agent reads that section and decides what to ignore

Both actors must follow this skill. The skill is always loaded.

> **TypeScript exclusion:** This skill does NOT govern TypeScript type errors or
> typecheck failures. Treat `tsc` / typecheck failures as task failures; they are
> handled separately via dedicated audit tasks on demand. Everything below applies
> to test suite failures only.

---

## Part 1 — Plan-time (Planner)

<HARD-GATE>
You MUST complete the discovery checklist below before writing any plan. The
"Pre-existing failures to ignore" section is MANDATORY in every plan — even when
empty. A plan that omits it is defective and must be corrected before an agent
picks it up.
</HARD-GATE>

### Discovery checklist

Work through every item in order. Mark each complete before moving on.

1. **Memory scan** — Open `.agents/memory/MEMORY.md` and scan for entries whose
   linked topic file names or hook lines mention suites, files, or patterns
   touched by this task. Pay particular attention to these known-flaky categories
   already documented:
   - `reverseVendorMap row-order flake` → vendor map suites
   - `vendor-map heap-order tests` → vendor map suites
   - `concurrent effects consume fetchWithAuth mocks out of order` → WarehouseMapView
   - `jest.clearAllMocks clears ALL mock implementations` → any suite using
     `clearAllMocks` in a `beforeEach`

2. **Recent task scan** — Query recently merged task descriptions for the words
   "pre-existing", "known failure", "flaky", or the names of suites the current
   task touches. Any match is a candidate for the list.

3. **Spot-run** — When the task touches `artifacts/api-server` code, run the
   api-server test suite once in its current state (before any changes) and record
   any failures. Those failures are pre-existing by definition.
   Skip this step if the task does not touch api-server code — it is expensive.

4. **Write the section** — Use one of the two templates below. Place it in the
   plan after "Steps" and before "Relevant files". Do not omit it.

---

### Plan section templates

**When pre-existing failures are known:**

~~~markdown
## Pre-existing failures to ignore
These failures exist on `main` before this task starts. Do not investigate or fix them.

- **[suite / test name]** — [one-line description: what fails, why it is pre-existing]
- *(add additional entries as discovered during planning)*

**Flaky-test rule:** If a test not listed above fails, retry it 3× in isolation
before concluding it is a regression you caused. Only treat a consistent 3/3
failure as your responsibility.

If the only remaining failures are those listed above (plus any self-classified
failures — see the Failure Gate skill), you are cleared to mark this task
complete. Do not attempt further validation fixes.
~~~

**When no pre-existing failures are found:**

~~~markdown
## Pre-existing failures to ignore
None known at plan time. Treat every failure as a potential regression.

**Flaky-test rule:** If a test fails, retry it 3× in isolation before concluding
it is a regression you caused. Only treat a consistent 3/3 failure as your
responsibility.
~~~

---

## Part 2 — Execute-time (Build agent)

<HARD-GATE>
Read the "Pre-existing failures to ignore" section at the start of every task
before touching any code. If the section is missing from the plan, add the
"None known" template variant now — then continue. Do not skip this step.
</HARD-GATE>

When a test or validation gate fails, work through the following decision tree
in order. Do not skip steps.

---

### Decision tree

**Step 1 — Check the plan section.**

- Failure is explicitly listed → **skip it**. Do not investigate. Do not fix.
  Go to Step 5.
- Section says "None known" or failure is not listed → continue to Step 2.

---

**Step 2 — 3× retry rule.**

Run the failing test in isolation three times (e.g. `npx jest <test-file> --testNamePattern="<name>"`).

- Passes on any retry → it is a **flaky pre-existing failure**. Log it (see Step 4)
  and go to Step 5.
- Fails all three times → continue to Step 3.

---

**Step 3 — Self-classification gate (any two of three).**

You may self-classify a consistent 3/3 failure as pre-existing only if you can
demonstrate **at least two** of the following three factors:

| Factor | How to demonstrate it |
|---|---|
| **File untouched** | The failing test file is not in your changeset. Run `git diff --name-only` and confirm neither the test file nor any file it directly imports appears in the output. |
| **Fails on main** | Stash or revert your changes (`git stash`), re-run the failing test in isolation, confirm it still fails, then restore your changes (`git stash pop`). |
| **Documented pattern** | The failure matches a named entry in `.agents/memory/MEMORY.md` or a recently merged task description — cite the specific entry. |

- Two or more factors demonstrated → self-classify as pre-existing. Log it (Step 4).
  Go to Step 5.
- Fewer than two factors → **treat as a regression you caused**. Fix it before
  marking the task complete. Do not proceed to Step 5.

---

**Step 4 — Self-classification log (mandatory when self-classifying).**

Emit the following line in your task output for each self-classified failure.
This creates a visible record so the Planner can add it to future plans.

```
[SELF-CLASSIFIED PRE-EXISTING] <test name or suite> — evidence: <factor1>, <factor2>
```

Example:
```
[SELF-CLASSIFIED PRE-EXISTING] reverseVendorMap › conflict winner — evidence: file untouched (git diff clean), fails on main (stash-verified)
```

---

**Step 5 — Completion check.**

Once all remaining failures are either:
- Listed in the plan's "Pre-existing failures to ignore" section, **or**
- Self-classified with logged evidence (Step 4),

→ You are cleared to mark this task complete.

**Do not attempt further validation fixes.**

---

## Regression hardening

The mandatory section in every plan is itself the guard. If an agent starts a task
and finds the section missing, it adds the "None known" template — the safe-direction
fallback — before any other work. This means:

- A missing section is never silently ignored
- The default (treat everything as a regression) is conservative, not permissive
- Self-classification logs give the Planner the data to improve future plans

Compliance spot-checks (verifying that merged plans contain the section) are handled
by the task-triage skill and dedicated audit tasks.

---

## Reference

- Source spec: `docs/superpowers/specs/2026-07-26-pre-existing-failure-handling-design.md`
- Known-flaky patterns: `.agents/memory/MEMORY.md`
