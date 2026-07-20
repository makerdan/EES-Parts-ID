---
name: "@types/react version split breaks mockup-sandbox typecheck"
description: Two coexisting @types/react versions cause "two unrelated types with this name" ref errors in shadcn UI components.
---

The rule: keep exactly one @types/react major.minor line across the whole workspace. parts-id pins `~19.1.x`; the catalog in pnpm-workspace.yaml must stay on the same line (`~19.1.17`), not `^19.2.0`.

**Why:** Hoisted untupled packages (lucide-react, react-day-picker) type-resolve against the `.pnpm/node_modules` fallback @types/react copy, which can differ from the catalog version a package installs locally. Any `pnpm install` can reshuffle which copy wins the fallback slot, so a previously green typecheck breaks with `VoidOrUndefinedOnly ... two different types with this name exist` / incompatible `Ref` errors in calendar.tsx / spinner.tsx / sonner.tsx — with no code change.

**How to apply:** If mockup-sandbox typecheck suddenly fails with unrelated-type ref errors after a lockfile refresh, check `ls node_modules/.pnpm | grep '@types+react@'` for a version split and re-unify via the catalog. Also: an interrupted `tsc --build` can leave a truncated `lib/api-client-react/dist/index.d.ts` ("not a module" errors in parts-id tests) — delete the lib's *.tsbuildinfo and rebuild typecheck:libs.
