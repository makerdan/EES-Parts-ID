---
name: Metro OOM in production build
description: Metro HTTP 500 during iOS bundle with no error output means Node OOM, not a code bug.
---

## The rule
When a Replit deployment build fails with Metro HTTP 500 mid-bundle AND there are no `[Metro Error]` lines in the build log, the cause is a Node.js out-of-memory (OOM) crash — not a code error.

**Why:** Metro in `--no-dev --minify` mode builds the full production bundle in one pass and holds the entire module graph in memory. At ~1,700+ modules with minification, the default Node.js heap (~1.5 GB) is too small.

**How to apply:** In `scripts/build.js`:
1. Add `NODE_OPTIONS: '--max-old-space-size=4096'` to the `env` object passed to the Metro `spawn()` call.
2. Add the same to the web build (`expo export`) `spawn()` env.
3. Also update `package.json` build script: `node --max-old-space-size=4096 scripts/build.js` so the orchestrator itself has headroom.

**Distinguishing OOM from code errors:**
- OOM → HTTP 500, no `[Metro Error]` in logs, failure is deep in bundle (>80%)
- Code error → HTTP 500 + `[Metro Error]` lines showing the bad module/import
