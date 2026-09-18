---
name: OpenAPI integer Zod enforcement
description: Generated Zod request schemas may not enforce OpenAPI integer semantics.
---

Do not assume an OpenAPI `type: integer` becomes a runtime `.int()` constraint in the generated Zod schema. Database-bound integer values need an explicit `Number.isSafeInteger` check at the server write boundary unless generated output has been verified to reject fractions.

**Why:** A fractional value passed generated request validation and reached a PostgreSQL integer column, turning a client validation error into a 500 response.

**How to apply:** For numeric request fields stored in integer columns, add boundary tests with fractional values and verify the handler returns 400 without attempting or changing persistence.