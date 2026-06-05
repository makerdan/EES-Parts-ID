---
name: react-test-renderer@19 toJSON vs root API
description: toJSON() silently drops conditional children in React 19; use renderer.root.findAll() instead.
---

# react-test-renderer@19: use root.findAll(), not toJSON()

## The rule
In `react-test-renderer@19`, always traverse the instance tree via `renderer.root.findAll()` instead of parsing `renderer.toJSON()` for assertions that look inside conditionally-rendered children.

## Why
`toJSON()` in React 19 can return a snapshot of the tree *before* conditional blocks have been flushed, silently omitting nodes inside `{condition && <…>}` branches. The header (always rendered) appeared in `toJSON()` but phase-conditional blocks did not. The root API (`renderer.root`) is a live reference to the current fiber tree and correctly reflects all rendered nodes.

## How to apply
```ts
// Helpers
function instText(node: TestInst | string): string {
  if (typeof node === "string") return node;
  return node.children.map(c => instText(c as any)).join("");
}
function findByTag(root: TestInst, tag: string) {
  return root.findAll(n => n.type === tag, { deep: true });
}
function findPressable(root: TestInst, text: string) {
  return findByTag(root, "rn-pressable").find(n => instText(n).includes(text)) ?? null;
}

// Render helper — wrap in act() so effects flush before first assertion
async function render(ui: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(ui); });
  return tree;
}
```

## Console warnings (cosmetic, not failures)
`"The current testing environment is not configured to support act(...)"` appears for state updates that fire inside promise continuations (e.g. after `await measureObject()`). These are harmless warnings; all tests pass.

## Relevant files
`artifacts/parts-id/__tests__/MeasurePartScreen.test.tsx`
