---
name: Node -e fixture arguments
description: How inline Node child fixtures receive arguments after the -e script.
---

Inline Node fixtures started with `node -e` receive their first fixture argument
at `process.argv[1]`; do not add a placeholder script filename when selecting
the fixture mode or writing marker paths.

**Why:** An extra placeholder shifts mode and marker arguments, causing a
supposedly normal fixture to hang and leaving misleading temporary files.

**How to apply:** Pass the mode as the first argument after the inline script
and keep marker paths immediately after it.