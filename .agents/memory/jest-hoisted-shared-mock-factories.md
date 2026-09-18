---
name: Jest hoisted shared mock factories
description: How shared Jest mock factories should be loaded when test mock declarations are hoisted.
---

Shared helpers referenced by a `jest.mock` factory must be loaded inside the factory callback, not through an imported binding declared later in the test file. Use `jest.requireActual` for both the helper module and the mocked module, then pass the real module into the shared factory.

**Why:** Jest evaluates hoisted mock factories before later test-file imports initialize. Referencing an imported helper from the callback can therefore throw a temporal-dead-zone error even though the helper import appears in the file.

**How to apply:** Keep the real-module `jest.requireActual` visible in each mock callback for contract scanners, and let the shared helper spread that actual module before applying targeted Jest-function overrides.