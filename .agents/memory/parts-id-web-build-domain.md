---
name: Parts ID web build domain
description: The production bundle script rejects preview domains while validating native output.
---

Parts ID production bundle regeneration must provide a non-preview deployment domain through `REPLIT_INTERNAL_APP_DOMAIN`; the default development domain is intentionally rejected by the native bundle guard.

**Why:** The build produces native bundles before exporting web output, and the native guard fails closed when any `*.replit.dev` domain is present.

**How to apply:** For deterministic local artifact regeneration, use the intended stable public deployment domain rather than `REPLIT_DEV_DOMAIN`.