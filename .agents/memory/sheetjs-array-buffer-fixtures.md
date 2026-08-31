---
name: SheetJS ArrayBuffer fixtures
description: SheetJS ODS test workbooks written with type array return an ArrayBuffer, not a number array.
---

**Rule:** When creating in-memory SheetJS ODS fixtures with `type: "array"`, pass the returned `ArrayBuffer` directly to the parser; do not wrap it with `Uint8Array.from()` as though it were a number array.

**Why:** SheetJS returns an `ArrayBuffer` for this output mode. Treating it as an array produces an empty byte buffer, making valid ODS parsing appear broken in Jest.

**How to apply:** Keep test fixture helpers typed as `ArrayBuffer`, or explicitly slice a typed-array view when a runtime returns one.