---
name: RNTL 14 async fireEvent
description: React Native Testing Library 14 interaction helpers own asynchronous React act scopes.
---

Await every `fireEvent` interaction before starting another interaction, render, wait helper, timer advance, or cleanup.

**Why:** In React Native Testing Library 14, `fireEvent`, `fireEvent.press`, and `fireEvent.changeText` are asynchronous and await an internal `act()` call. Leaving one unawaited creates overlapping React 19 act scopes even when the event handler itself appears synchronous.

**How to apply:** In React Native tests using this library version, use `await fireEvent.*(...)` directly. Do not wrap those calls in another async `act()`, and await observable asynchronous outcomes only after the event promise settles.