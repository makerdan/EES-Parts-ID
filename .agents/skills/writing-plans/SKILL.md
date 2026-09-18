---
name: writing-plans
description: Convert an approved design spec into a detailed, ordered implementation plan. Use after the brainstorming skill produces a reviewed and approved spec document. Do NOT use to plan work that hasn't gone through brainstorming first.
---

# Writing Implementation Plans

Convert an approved design spec into a concrete, ordered implementation plan that an executor agent can pick up and run without ambiguity.

<HARD-GATE>
Do NOT begin writing the plan until you have verified the spec document exists, has been approved by the user, and passes the pre-plan checklist below. A plan written against an incomplete or unapproved spec wastes implementation work.
</HARD-GATE>

## Checklist

Work through every item before finalising the plan. Each item must be explicitly satisfied — mark it complete inline as you go.

1. **Locate the spec** — find the spec file under `docs/superpowers/specs/` and confirm it is the approved version
2. **Completeness check** — no TODOs, TBDs, or placeholder sections remain
3. **Scope check** — spec covers a single implementable unit; if it spans multiple independent subsystems, decompose into sub-plans first
4. **Dependency inventory** — list every external service, package, env var, or migration the plan depends on
5. **Task ordering** — sequence tasks so no task depends on work that comes after it; flag and resolve cycles
6. **Regression hardening** — the plan must contain at least one named task or sub-task whose explicit purpose is to prove a specific problem cannot recur undetected (a test, an assertion, a CI check, a lint rule, or equivalent). Framework and tooling are the implementer's choice — the requirement is that *something* actively catches a regression. **If no such item exists, the plan is incomplete and must be updated before it is finalised.**

<REGRESSION-HARDENING-GATE>
Before writing the final plan, answer this question:

> "If the core behaviour this plan implements silently broke tomorrow, what would catch it?"

If the answer is "nothing", add a regression hardening task now. The task must name what it catches and how — not just "add tests". It may be as simple as:

- A unit test that asserts the specific behaviour
- An integration test covering the happy path end-to-end
- A CI check (lint rule, type check, schema check) that rejects the broken state
- An assertion in existing test infrastructure that covers this code path

The task may reuse existing test infrastructure. It does NOT require a new framework. But it must be explicit and it must be present.
</REGRESSION-HARDENING-GATE>

## Plan Format

Write the plan as a markdown file at `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`.

### File Structure

```markdown
# Implementation Plan: <Topic>

## Source Spec
- Spec file: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Approved by user: [date]

## Dependencies
- [List any packages, services, env vars, migrations, or other prerequisites]

## Tasks

### T001: <Task title>
- **Blocked by**: []
- **Files**: [list of files to create or modify]
- **Details**: [what to do and why — enough for an executor agent to proceed without the spec]
- **Done when**: [concrete, observable acceptance criterion]

### T002: <Task title>
- **Blocked by**: [T001]
...

### TNNN: Regression hardening — <what it catches>
- **Blocked by**: [list prerequisite tasks]
- **Files**: [test files or CI config]
- **Details**: [what to assert, what framework/tool to use, what the test must prove]
- **Done when**: [the check runs and passes in CI / the test suite]
```

### Naming Conventions

- Tasks are numbered `T001`, `T002`, … in execution order
- The regression hardening task must include "Regression hardening" in its title so it is easy to locate
- Acceptance criteria use observable outcomes ("the endpoint returns 200", "the test suite passes", "the type-check step exits 0") — not process descriptions ("implement the handler")

## After Writing the Plan

1. **Self-review** — re-read the plan as if you are the executor. Is every task unambiguous? Does every acceptance criterion have an observable outcome? Is the regression hardening task specific enough to implement?
2. **Commit** the plan file to git
3. **Notify the user** — share the plan path and a one-paragraph summary of the task sequence
4. **Hand off** — the plan is ready for an executor agent; do not begin implementation yourself unless explicitly asked
