---
name: Mapped Jest context mocks
description: How to configure a Jest mock when moduleNameMapper resolves a project context to a manual mock file.
---

When Jest maps a project module to a manual mock file, configure the exported mock function from that mapped module in the test rather than assuming a separate local spy or factory is the instance the component consumes.

**Why:** The screen and test can otherwise reference different mock instances, making role-sensitive branches appear unauthenticated even though the test configured an admin token.

**How to apply:** Import the mapped mock export (or load it dynamically after the test mocks are installed), cast it to the appropriate Jest mock type, and set its return value in each test setup.