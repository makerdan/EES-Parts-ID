---
name: Schema-validated .replit replacement
description: How to safely update the root Replit configuration when direct edits are blocked.
---

Root `.replit` changes must be written as a complete TOML document to an absolute
temporary workspace file and applied through `verifyAndReplaceDotReplit`.

**Why:** The workspace rejects direct edits to `.replit`; the replacement flow
parses and validates the whole document before changing the active configuration.

**How to apply:** Read the current file, generate the full intended TOML in a
temporary file, call the validator/replacer, then remove the temporary file and
run the relevant configuration checks.