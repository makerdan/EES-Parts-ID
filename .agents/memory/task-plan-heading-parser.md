---
name: Task-plan heading parser
description: Validation tier parsing is sensitive to the order of similarly prefixed headings in archived task plans.
---

The locked validation runner matches `## Validation` with a prefix-style regular
expression, so a preceding `## Validation tier` heading can be mistaken for the
detailed validation section.

**Why:** A plan can pass the standalone Failure Gate while still failing the
locked runner if the legacy tier heading appears before the detailed section.

**How to apply:** Put the detailed `## Validation` section before the exact
`## Validation tier` declaration, and keep both tier values synchronized.