/**
 * Jest stub for http-proxy-middleware.
 *
 * The real package ships ESM-only (`export * from './factory.js'`), which
 * ts-jest's CommonJS transform cannot parse, so importing it (transitively via
 * app.ts → clerkProxyMiddleware.ts) crashes every suite. No test exercises the
 * Clerk reverse-proxy path, so a passthrough factory is sufficient. Wired in via
 * moduleNameMapper in jest.config.cjs.
 */
function createProxyMiddleware() {
  return (_req, _res, next) => next();
}

module.exports = { createProxyMiddleware };
