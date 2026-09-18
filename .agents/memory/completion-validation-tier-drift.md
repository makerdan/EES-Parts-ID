---
name: Completion validation tier drift
description: Completion callbacks may execute broader validation tiers than the assigned task plan declares.
---

The completion callback can launch all registered validation tiers even when the task plan explicitly requires one lighter tier. If the declared tier passes but broader tiers fail in unrelated suites, preserve the task scope and report the broader failures with an audited validation-skip reason rather than changing unrelated code.

**Why:** A provider-contract task passed its declared fast validation, while automatic completion also ran standard and heavy suites that failed in an unrelated parts-id test process.

**How to apply:** Compare the callback logs with the task plan, confirm the declared command passed, identify the unrelated failing suite and unchanged files, and include the exact scope mismatch and failure evidence when completing.