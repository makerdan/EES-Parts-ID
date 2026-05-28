---
name: Metro silent HTTP 500 during production build
description: React Compiler Babel worker crash (NOT OOM) causes silent Metro HTTP 500 during iOS production bundling.
---

## The rule
When a Replit deployment build fails with **Metro HTTP 500 mid-bundle AND no `[Metro Error]` output**, the cause is the **React Compiler (`babel-plugin-react-compiler`) crashing in a Babel worker thread** while processing a very large component — NOT a Node.js OOM.

**Why OOM was ruled out:** The failure percentage changes build-to-build (84% one build, 92% another). A true memory crash would fail at the same memory-usage threshold. Variable failure point = specific module being hit.

**Why React Compiler:** `babel-preset-expo` auto-detects `babel-plugin-react-compiler` in devDependencies and enables it silently. When the compiler's data-flow analysis runs on an extremely large component function (~1700+ lines), it crashes the Babel worker thread. Worker thread crashes are swallowed — they produce no `[Metro Error]` log entry and cause Metro to return HTTP 500.

**How to apply:**
1. For large component functions (>500 lines), add `"use no memo";` as the first line of the function body to opt out of React Compiler optimization.
2. The directive is valid JS/TS — TypeScript accepts it without errors.
3. Components to watch: any screen with 20+ `useState` calls, any 1000+ line render function.

**Diagnostic upgrade:** In `scripts/build.js` `downloadFile()`, capture the HTTP 500 response body with `response.text()` and log it as `[Metro Error Body]`. This will show the exact transform error in the next build.

**Earlier wrong fix:** `--max-old-space-size=4096` was applied but didn't help — confirms it's not OOM.

**Confirmed fixed in `upload.tsx` (UploadScreen) and `admin.tsx` (AdminDashboardScreen)** via `"use no memo"`.
