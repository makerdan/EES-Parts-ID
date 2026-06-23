---
name: FlatList ListHeaderComponent inline function remounts children
description: Inline arrow function passed to ListHeaderComponent causes React to remount the entire header subtree (and destroy all state) on every parent re-render. Fix by passing a JSX element instead.
---

## The Rule
Never pass an inline arrow function as `ListHeaderComponent` to a `FlatList` (or `SectionList`/`VirtualizedList`) when the header contains stateful components.

```jsx
// BAD — new function reference every render → remounts header subtree
<FlatList ListHeaderComponent={() => <MyStatefulComponent />} />

// GOOD — stable element reference → header reconciles in-place
<FlatList ListHeaderComponent={<MyStatefulComponent />} />
```

**Why:** React Native's VirtualizedList checks `ListHeaderComponent` by reference. When an inline arrow function is used, every parent re-render produces a new function reference. React sees a new *component type*, unmounts the old header (destroying all descendant state), and mounts a fresh one. When a JSX element is passed, React reconciles by the element's stable component type (`View`, etc.) and no remount occurs.

**How to apply:** Any time a `FlatList` header contains stateful children (file pickers, form inputs, multi-step UI), ensure `ListHeaderComponent` is either:
1. A JSX element: `ListHeaderComponent={<View>...</View>}`
2. A `useCallback`-memoized function with stable deps

**Observed impact:** The `CatalogPdfUpload` component inside the enrichment tab's `FlatList` had its `pdfBytes`/`filename` state wiped on every parent re-render. The file picker dialog closing triggers a window focus event → parent poll/inventory state update → re-render → header remounts → picked PDF evaporates. Fixed by changing from `() => (...)` to a bare JSX element.
