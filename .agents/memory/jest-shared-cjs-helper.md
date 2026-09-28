---
name: Jest shared CJS helper
description: Shared source-inspection helpers used by ESM scripts and CommonJS Jest suites need a CommonJS bridge.
---

When a helper is consumed by both standalone ESM validation scripts and the API Jest configuration, publish it as CommonJS and import its default export from ESM code.

**Why:** The API Jest runner parses a `.mjs` file passed to `require()` as CommonJS and fails on `export`, while Node can load a `.cjs` module from either side without a second implementation.

**How to apply:** Keep the helper's public functions on `module.exports`; use an ESM default import in standalone scripts and `require()` in Jest tests.