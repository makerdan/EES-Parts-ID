---
name: Generated output inventory
description: Adding an OpenAPI component can create new generated type files that must be registered before codegen checks pass.
---

When OpenAPI codegen creates new files under `lib/api-zod/src/generated/types`, add those files to the tracked generated-output manifest in the same change.

**Why:** The repository intentionally fails codegen checks on unregistered generated files, even when Orval output and typechecking are correct.

**How to apply:** After changing `lib/api-spec/openapi.yaml`, run codegen, inspect untracked generated files, update the manifest, and run the generated-output check before broader validation.