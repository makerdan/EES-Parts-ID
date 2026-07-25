---
name: expo-file-system source typecheck leak
description: expo-file-system ships main:"src/index.ts", so tsc typechecks its .ts sources; strict flags then error inside node_modules. Fix via tsconfig paths to build/*.d.ts.
---

# expo-file-system source typecheck leak

expo-file-system's package.json has `main: "src/index.ts"`, so `tsc` in parts-id resolves imports (e.g. `expo-file-system/legacy`) to the package's **TypeScript sources**, which get typechecked with the app's compiler flags. Enabling `exactOptionalPropertyTypes` then produced an unfixable error inside `node_modules/.../src/legacy/FileSystem.ts` (skipLibCheck does not apply to .ts files).

**Fix:** map the subpath to the shipped declaration file in `artifacts/parts-id/tsconfig.json`:

```json
"paths": {
  "expo-file-system/legacy": ["./node_modules/expo-file-system/build/legacy/index.d.ts"]
}
```

`.d.ts` files fall under skipLibCheck, so the dependency no longer errors.

**How to apply:** if a future strict-flag bump surfaces errors inside a node_modules `src/*.ts` file, don't weaken the flag — alias the import to the package's `build/*.d.ts` via paths. Note the path must be relative to the artifact's own node_modules (pnpm), not the repo root.
