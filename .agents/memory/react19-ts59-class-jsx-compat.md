---
name: React 19 + TypeScript 5.9 class-based JSX compat shim pattern
description: How to fix TS2786/TS2607/TS2322 when react-native-svg / expo-camera / expo-blur fail the JSX class-element check with @types/react@19 + TS 5.9.
---

# React 19 + TypeScript 5.9 class-based JSX compat shim

## The Rule
Create an **ambient** `.d.ts` file (zero top-level imports/exports = script mode) at `artifacts/parts-id/types/third-party-compat.d.ts`. Use `declare module "lib-name" { ... }` blocks — in a script-mode file these **replace** (not augment) the module types.

## Why
react-native-svg's `Shape<P>` declares `[x: string]: unknown`. TypeScript 5.9's stricter JSX class-element check requires the class instance to be assignable to `Component<any, any, any>`, but the index signature prevents that assignment. expo-camera's `CameraView` and expo-blur's `BlurView` are also class-based and hit the same wall. `skipLibCheck: true` does NOT help — these are usage-site errors, not lib-file errors.

## How to Apply
Inside each `declare module` block:
1. `export * from "lib/internal/subpath"` — re-exports everything from a non-circular subpath
2. `export declare const Svg: React.ComponentType<SvgProps>` — specific named export OVERRIDES the wildcard for that name
3. For components that also need `ref` support, use `React.ForwardRefExoticComponent<Props & React.RefAttributes<Ref>>` and also `export type CameraView = CameraViewRef` so `useRef<CameraView>` types the ref correctly
4. For `GestureHandlerRootView` (function component, not class): add a `declare module "react-native-gesture-handler"` block in the same ambient file with `export * from "..../index"` plus a specific `GestureHandlerRootView: React.ComponentType<ViewProps & { children?: ReactNode }>` override — module augmentation of the *submodule* interface does NOT work reliably in TS 5.9

## Key Gotchas
- Submodule augmentation (`declare module "lib/path/to/Component" { interface Props { children? } }`) *partially* works but breaks the extends chain, causing OTHER props (like `style`) to disappear from JSX checking. Use the ambient replacement approach instead.
- `SvgFromXml` and `SvgFromUri` in `react-native-svg/lib/typescript/xml` are also class-based; if re-exported via `export * from` they'd re-introduce the error, so avoid `export * from 'react-native-svg/lib/typescript/xml'` and instead use selective exports.
- expo-camera renamed `takePictureAsync` → `takePicture` in CameraViewRef. Any call site using the old name needs updating (`MeasurePartScreen.tsx`).
- Libraries with no `exports` field in package.json allow any internal subpath to be resolved directly (both at type-check time and in ambient `export * from` within declare module blocks).
