---
name: Drizzle SQL static helpers in Jest mocks
description: Startup tests may mock drizzle-orm with only the sql tag, so shared probes must account for incomplete SQL helper mocks.
---

When a shared server utility uses Drizzle SQL helpers, remember that API startup
tests may replace `drizzle-orm` with a lightweight mock exposing only the `sql`
tag. Static helpers such as `sql.join`, `sql.fromList`, or `sql.raw` may be
missing in that test runtime even when they exist in the real package.

**Why:** The startup suite intentionally mocks database dependencies and
Drizzle operators to isolate lifecycle ordering. A production-valid helper can
otherwise crash the entire Jest worker before it writes a test result.

**How to apply:** Prefer SQL construction that matches the mocked surface, or
extend the canonical startup mock when a helper is genuinely required. Keep
the real runtime path covered by at least one test that invokes the helper
without the mock.