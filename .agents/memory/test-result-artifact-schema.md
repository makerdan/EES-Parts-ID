---
name: Cross-run test result artifact schema
description: Shared validation rules for Jest and Vitest JSON result artifacts used by the aggregate test runner.
---

Jest and Vitest result JSON share the execution-count fields and nested assertion results, but Vitest may omit `numRuntimeErrorTestSuites`. Treat that field as optional while requiring the core suite/test counts and nested result arrays.

**Why:** Making the runtime-error count mandatory caused valid Vitest reporter output to be rejected even though it contained complete executed-test evidence.

**How to apply:** When tightening aggregate result validation, preserve the Jest/Vitest intersection and count only passed or failed assertions as executed; pending, todo, and skipped assertions are not positive evidence.