---
name: Contract assertion normalization
description: Static prose contracts should be checked semantically rather than by physical line wrapping.
---

Normalize whitespace before applying regex assertions to instructional
contracts, while keeping exact structural checks such as frontmatter separate.

**Why:** Markdown line wrapping is editorial formatting, not a change in the
contract. Line-sensitive assertions created false failures during the
Skill Mirror Sync contract hardening.

**How to apply:** Use a whitespace-normalized copy for semantic presence and
absence checks; reserve the raw source for syntax, delimiters, and line-count
checks.
