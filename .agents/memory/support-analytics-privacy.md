---
name: Support analytics privacy
description: Durable privacy decisions for screen-view telemetry and its admin reporting contract.
---

Use existing server-held configuration for visitor grouping, with a domain-separated
keyed digest and a bounded rotation window. If no suitable material is configured,
disable unique-visitor reporting rather than falling back to an unkeyed identifier.

**Why:** A stable plain digest of a network identifier remains linkable over time,
while weakening the fallback would make the privacy guarantee depend on deployment
configuration.

**How to apply:** Keep client events finite and versioned, clear legacy unkeyed
grouping during privacy migrations, and make every report/export disclose its UTC
window, suppression threshold, and whether unique visitors are available.