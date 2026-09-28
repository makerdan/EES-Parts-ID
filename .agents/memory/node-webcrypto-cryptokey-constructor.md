---
name: Node Web CryptoKey test constructor
description: How Node-based browser-path tests can satisfy production instanceof CryptoKey checks.
---

Node's Web Crypto implementation may provide working `subtle` APIs without exposing a `CryptoKey` constructor as a property of the `webcrypto` object. For tests that exercise browser code using `instanceof CryptoKey`, generate a temporary key and install its constructor as the test global.

**Why:** Assigning `webcrypto.CryptoKey` can install `undefined`, causing a misleading runtime failure in otherwise valid browser encryption tests.

**How to apply:** In Node Jest suites that test Web Crypto browser paths, generate a key with `subtle.generateKey` and use `generatedKey.constructor` for the global `CryptoKey`.