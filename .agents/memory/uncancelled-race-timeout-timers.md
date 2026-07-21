---
name: Uncancelled Promise.race timeout timers keep Jest workers alive
description: Why "Jest did not exit" warnings appear and how to find/fix the timer leaks
---
Any `Promise.race([work, timeoutPromise])` where the timeout's `setTimeout` is not cleared (or at least `.unref()`d) keeps the Node process alive for the full timeout after the race settles. In Jest this surfaces as "Jest did not exit one second after the test run has completed".

**Why:** Two real leaks were found this way in api-server: the 15s Poe bot probe timeout in aiProvider and the module-level 25s/8s startup fallback timers in index.ts (fired on mere import by startup tests).

**How to apply:**
- Capture the timer handle, `clearTimeout` in a `finally` after the race, and `.unref()` fallback-only timers.
- To locate leaking suites: run each test file in its own `npx jest --runTestsByPath <file>` process and grep output for "did not exit one second" (see `artifacts/api-server/scripts/scan-open-handles.sh`), then confirm with `--detectOpenHandles` on the flagged suite.
