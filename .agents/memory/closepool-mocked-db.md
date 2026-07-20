---
name: closePool must tolerate mocked @workspace/db
description: Global afterAll pool teardown runs in every suite, including ones that jest.mock the db module.
---
The api-server jest.integrationSetup.cjs registers a global afterAll calling testDb's closePool() in EVERY test file — including suites that `jest.mock("@workspace/db")`, where `pool` is undefined. A `_poolEnded` flag alone doesn't help; the crash was `pool.end` on undefined, marking fully-green suites as failed.

**Why:** teardown-only crashes made passing suites look red in the coverage gate.

**How to apply:** any shared teardown helper invoked unconditionally from setupFilesAfterEnv must guard against mocked/missing resources (`if (!pool || typeof pool.end !== "function") return;`) and swallow double-end, not just gate on a module-local flag (jest.resetModules gives a fresh flag).
