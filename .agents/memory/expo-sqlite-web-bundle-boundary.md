---
name: Expo SQLite web bundle boundary
description: Why native-only SQLite imports need a separate web module in an Expo project that also exports to browser.
---

An Expo module used only on native still needs a platform-specific web implementation if the shared import resolves to expo-sqlite. Runtime Platform checks do not keep its WASM worker out of the browser bundle.

**Why:** Metro follows static imports while bundling web and can fail on the worker's WASM import even though no web path invokes the native store.

**How to apply:** Put the SQLite implementation behind platform file resolution, provide an explicit web implementation that does not import SQLite, and register the platform-specific entrypoint with dead-export analysis.