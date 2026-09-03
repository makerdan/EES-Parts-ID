---
name: Jest canonical mock factories
description: How explicit Jest mock factories can reuse a shared manual mock without recursive resolution.
---

When a test uses `jest.mock("module", factory)` but the module already has a canonical manual mock, load that mock through `jest.requireActual` with an absolute filesystem path rather than requiring the mocked module name or a relative module path.

**Why:** Jest resolves relative or package-name requires through its active mock registry inside the factory, which can recurse into the factory or select the wrong mock.

**How to apply:** Keep the manual mock as the maintained contract, expose a small shared factory for suites that need explicit mocking, and resolve the manual mock path from the factory module's directory. If moduleNameMapper already supplies the canonical mock, do not add a factory that requires the mapped module name; remove the redundant mock or require the manual file by absolute path.