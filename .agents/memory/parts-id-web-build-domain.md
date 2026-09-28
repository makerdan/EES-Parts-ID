---
name: Parts ID web build domain
description: The production bundle script rejects preview domains while validating native output.
---

Parts ID production bundle regeneration must provide a non-preview deployment domain through `REPLIT_INTERNAL_APP_DOMAIN`; the default development domain is intentionally rejected by the native bundle guard.

**Why:** The build produces native bundles before exporting web output, and the native guard fails closed when any `*.replit.dev` domain is present.

**How to apply:** For deterministic local artifact regeneration, use the intended stable public deployment domain rather than `REPLIT_DEV_DOMAIN`.

The production build script can reuse an already-running development Metro server. In that case, setting the stable domain for the build process alone does not replace preview-domain URLs already baked into Metro's native output, and the native-domain guard fails before web export. For a web-only publishing failure, verify a fresh `expo export --platform web` with the production-domain public inputs and run the build's contact-data, content-hash, and domain guards on that output. Do not treat a native-domain failure from reused development Metro as evidence that the web export still fails.