---
name: pdfjs-dist v5 Node.js legacy build
description: pdfjs-dist v5+ throws "DOMMatrix is not defined" in Node.js; must use the legacy build path instead.
---

**Rule:** Always import pdfjs-dist as `pdfjs-dist/legacy/build/pdf.mjs` in any Node.js (server-side) context.

**Why:** pdfjs-dist v5 uses `DOMMatrix` internally (a browser-only Web API). Node.js 24 does not expose it as a global. The library itself emits a warning: "Please use the `legacy` build in Node.js environments." The legacy build polyfills or avoids browser-specific APIs.

**How to apply:** In any file that runs on the API server (not in the Expo/browser bundle), replace `import("pdfjs-dist")` with `import("pdfjs-dist/legacy/build/pdf.mjs")`. The exported API surface is identical — `getDocument`, `GlobalWorkerOptions`, `OPS`, etc. are all present.
