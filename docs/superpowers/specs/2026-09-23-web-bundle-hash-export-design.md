# Keep web export hashes consistent

## Problem
The web export can omit a top-level platform argument in Metro's custom serializer. The current guard then skips web sanitization, leaving contact metadata in generated JavaScript. Post-export cleanup removes it but changes the final bytes without changing the content-hash filename, so publishing fails.

## Design
Keep the explicit native-platform pass-through. When the platform is web or unspecified, inspect the serialized artifact list and recognize web bundles from `static/js/web/` filenames. Sanitize web JavaScript in the serializer, rename hashed JavaScript and source maps, and rewrite artifact references using the existing logic. Do not alter native bundles or relax the final on-disk hash/contact-data checks. The post-export sanitation remains a safety net and should not change bytes when the serializer did its work.

## Alternatives
- Post-export renaming of JavaScript and all references: possible, but risks broken lazy chunks and stale HTML/metadata references.
- Disabling the hash check: rejected because it would hide the error without repairing the published files.

## Regression check
Add a serializer fixture without platform metadata that contains web entry and lazy-chunk artifacts, contact metadata, maps, and HTML references. Assert sanitized content, matching hashed filenames, and rewritten references; retain the explicit iOS/Android byte-for-byte pass-through tests. Run the focused suite and the production web export/build to confirm the final on-disk hash guard passes.