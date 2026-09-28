---
name: Task-plan heading parser
description: Validation tier parsing is sensitive to the order of similarly prefixed headings in archived task plans.
---

Required plan-section parsers must match exact level-two headings with
multiline-aware expressions; prefix matching lets aliases or `## Validation tier`
masquerade as `## Validation`.

**Why:** A plan can pass the standalone Failure Gate while still failing the
locked runner if the legacy tier heading appears before the detailed section.

**How to apply:** Require exact `## Validation`, `## Validation tier`, and other
mandated headings in every guard, and keep both validation tier values
synchronized.