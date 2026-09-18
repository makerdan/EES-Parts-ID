---
name: ts-ignore leaks into inferred return type
description: Why @ts-ignore inside an object literal (e.g. a Reanimated worklet) still causes type errors at the use site, and the correct fix.
---

**Rule:** A `@ts-ignore` / `@ts-expect-error` on a property line inside an object literal only silences diagnostics on that line — the offending property (e.g. `cursor?: string`) still becomes part of the object's *inferred type*. If that object is a function return value (like a `useAnimatedStyle` worklet), the error resurfaces wherever the value is consumed (`style={[...]}`), far from the ignore comment.

**Why:** Hit in the parts-id warehouse map: a web-only `cursor: "grab"` spread inside `useAnimatedStyle` carried an old `@ts-ignore`, yet `tsc` failed at the `<Animated.View style=...>` site because RN's `CursorValue` only allows `"auto" | "pointer"`. The ignore comment gave false confidence for multiple merges until `exactOptionalPropertyTypes`-era strictness surfaced it downstream.

**How to apply:** Never `@ts-ignore` a property that leaks into an inferred type. Instead cast the *value* so inference produces an assignable type (e.g. `cursor: "grab" as unknown as "pointer"` with a comment), or type the whole return explicitly. Same logic applies to any hook/factory whose return type is inferred from a literal.
