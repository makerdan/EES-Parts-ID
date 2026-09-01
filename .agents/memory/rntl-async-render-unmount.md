---
name: Async React Native Testing Library render and unmount
description: React 19 route-boundary tests in this repository use asynchronous render and unmount operations.
---

React Native Testing Library's `render()` and `unmount()` return promises in the current React 19 test setup; route transitions must be wrapped in awaited `act(async () => ...)`.

**Why:** Checking the tree or cleanup synchronously can observe a still-mounted route, leaving request abort and listener-removal assertions falsely negative and contaminating later tests.

**How to apply:** Always `await render(...)`, `await act(async () => { ... })` around navigation or event-driven state changes, and `await tree.unmount()` during teardown.