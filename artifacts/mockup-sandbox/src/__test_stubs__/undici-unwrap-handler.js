'use strict';
// Compatibility stub: jsdom@29 expects this file from undici@6, but undici@8
// removed it. Provides a pass-through unwrap() so jsdom's dispatcher can
// call dispatch(opts, UnwrapHandler.unwrap(h)) without crashing.
class UnwrapHandler {
  static unwrap(handler) { return handler; }
}
module.exports = UnwrapHandler;
