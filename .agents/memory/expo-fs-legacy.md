---
name: expo-file-system v19 legacy subpath
description: expo-file-system@19 split old API to a /legacy subpath; bare import only has new streaming API.
---

# expo-file-system v19 legacy subpath

## Rule
Always import from `expo-file-system/legacy` (not `expo-file-system`) when using:
- `FileSystem.cacheDirectory`
- `FileSystem.getInfoAsync()`
- `FileSystem.downloadAsync()`
- `FileSystem.makeDirectoryAsync()`
- `FileSystem.deleteAsync()`
- `FileSystem.readDirectoryAsync()`

The bare `expo-file-system` import only exports the new streaming/SAF API and TypeScript will error on these properties.

**Why:** expo-file-system@19 (SDK 54) moved the legacy filesystem API to a dedicated subpath to avoid bundling both APIs. The top-level export no longer includes the old synchronous-style helpers.

**How to apply:** Any utility that touches on-device file caching (tile cache, image resize, etc.) should `import * as FileSystem from "expo-file-system/legacy"`. Jest mocks go in `__mocks__/expo-file-system-legacy.js`.
