---
name: API auth before body parsing
description: Security constraints for Express APIs with public read routes and large authenticated uploads
---

Public API access must be matched by both HTTP method and route template, and the common Clerk/application guard should run before large body parsers.

**Why:** A path-prefix allowlist can accidentally expose a write endpoint under a public read prefix, while parsing upload bodies before authentication lets unauthenticated callers consume substantial memory before being rejected.

**How to apply:** Keep the public route contract explicit and method-aware. Mount Clerk resolution and the common app guard before route-specific and global JSON/raw parsers; leave only small pre-parser request-size checks ahead of authentication when necessary.