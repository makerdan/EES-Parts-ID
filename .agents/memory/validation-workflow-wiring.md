---
name: Validation workflow wiring
description: How validation workflows get created/wired into the Project CI gate on this Replit project
---
- `.replit` cannot be edited directly; use the validation skill's `setValidationCommand(name, command)` — it creates the workflow with `isValidation = true` AND auto-appends a `workflow.run` task to the `Project` gate.
- `removeWorkflow(name)` also removes the workflow's task entry from the `Project` gate automatically.
- **Why:** direct `.replit` edits are blocked by the platform; discovering the auto-wiring saves a manual-wiring detour.
- **How to apply:** when adding/removing CI checks, use these callbacks and just verify `.replit` afterwards with grep.
- `setValidationCommand` upserts by exact name: a same-named existing workflow is converted in place; a different name (e.g. `codegen-check` vs `codegen:check`) creates a duplicate entry — clear the old one with `clearValidationCommand`. Validation-backed entries still appear in `listWorkflows` but do not consume workflow slots.
- Under the parallel Project gate, api-server integration tests can mass-fail with 403s (shared DB interference); solo runs pass. Re-run suspicious suites solo before concluding they are broken.
- Updating an existing validation command can append that command to the Project gate even when the gate intentionally runs only one lightweight command. **Why:** the extra task makes the port/gate contract fail despite the command itself being correct. **How to apply:** after an upsert, inspect the Project task list; if it gained an unwanted task, use the schema-validated whole-file `.replit` replacement flow to remove only that task while retaining the validation workflow.
