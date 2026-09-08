---
name: Replit active configuration read boundary
description: Replit documents .replit/editor access but no supported runtime API or CLI for reading a separate active configuration snapshot.
---

The platform-provided `/run/replit/env` metadata is environment-only and may contain secrets; it is not a safe source for `.replit` parity checks. Replit's documented configuration access remains the checked-in `.replit` file/editor, and the installed CLI exposes no configuration-read command.

**Why:** A stale platform-side configuration cannot be detected safely by inventing an endpoint or hashing runtime environment metadata.

**How to apply:** Only add active-configuration parity when Replit documents a read-only source that excludes environment values; require complete structural data and fail closed on partial snapshots.