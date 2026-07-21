---
name: pdfjs Jest moduleNameMapper stub
description: Why pdfjs-dist/legacy/build/pdf.mjs must be stubbed via moduleNameMapper, not jest.mock virtual
---
Rule: never rely on `jest.mock("pdfjs-dist/legacy/build/pdf.mjs", factory, {virtual:true})` alone — map the specifier in `moduleNameMapper` to a CJS stub so the real ESM file is never resolved.

**Why:** the real pdf.mjs uses `import.meta` at module scope, which the Jest CJS runtime cannot parse. With only a per-file jest.mock, full parallel runs intermittently parsed the real file ("Cannot use 'import.meta' outside a module") even though standalone runs passed. A resolver-level mapper is deterministic.

**How to apply:** keep the mapper entry in api-server's jest.config.cjs pointing at `__mocks__/pdfjs-dist-legacy.cjs`; tests still `jest.mock()` the same specifier with their own factory for behaviour.
