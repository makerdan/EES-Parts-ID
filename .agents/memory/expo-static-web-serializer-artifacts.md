---
name: Expo static web serializer artifacts
description: Expo static export custom-serializer behavior needed for web-only content-hash rewrites.
---

For the current Expo/Metro export path, the custom serializer's static artifact filenames include `static/js/web/`, while the serializer argument's platform metadata is not reliably exposed at the expected top level. Use the artifact path to identify web output, then update JavaScript filenames, source-map filenames, and every artifact-source reference together.

**Why:** Checking only the serializer argument allowed a real web export to bypass sanitization and left its entry filename hashed from pre-sanitized bytes.

**How to apply:** Keep native serializer output untouched; apply any web-only byte transform before returning static artifacts, and verify the final on-disk JavaScript bytes against their content-hash filenames.