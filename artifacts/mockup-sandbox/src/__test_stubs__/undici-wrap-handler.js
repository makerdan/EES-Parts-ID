'use strict';
// Compatibility stub: jsdom@29 expects this file from undici@6, but undici@8
// removed it. The WrapHandler and UnwrapHandler APIs are no longer needed in
// undici@8 — return pass-through stubs so jsdom can initialize.
class WrapHandler {
  constructor(handler) { this.handler = handler; }
  static wrap(handler) { return new WrapHandler(handler); }
}
module.exports = WrapHandler;
