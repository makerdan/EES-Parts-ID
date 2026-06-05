---
name: Stable mock refs for useEffect deps in RN tests
description: Why useCameraPermissions (and similar hooks) must return stable references in Jest mocks, or useEffect resets state after every update.
---

# Stable mock refs for useEffect deps in RN tests

## The rule
When mocking hooks that return objects or functions (e.g. `useCameraPermissions`), always create the returned values **once** in the mock factory — not inline on every call.

**Wrong:**
```ts
useCameraPermissions: jest.fn(() => [{ granted: true }, jest.fn()])
```
Every call creates a new object and a new function. Both are new references on every render.

**Right:**
```ts
jest.mock("expo-camera", () => {
  const permission = { granted: true };
  const requestPermission = jest.fn();
  return {
    CameraView: () => null,
    useCameraPermissions: jest.fn(() => [permission, requestPermission]),
  };
});
```

## Why
`useEffect` in `MeasurePartScreen` (and many similar components) includes `[permission, requestPermission]` in its deps array. If either is a new reference on every render, React sees "deps changed" after every state update, re-fires the effect, and `setPhase("preview")` cancels any phase transition being tested.

## How to apply
Any time a mock hook returns an object literal or `jest.fn()` inline in its return expression, extract both to module-scope `const` values inside the `jest.mock` factory. This applies to camera permissions, location, push-notification permission hooks, etc.

## Relevant file
`artifacts/parts-id/__tests__/MeasurePartScreen.test.tsx`
