/**
 * Jest stub for @clerk/express.
 *
 * Wired in via moduleNameMapper in jest.config.cjs so it applies to every
 * test suite without per-file jest.mock() calls.
 *
 * Auth model for tests: the `Authorization: Bearer <token>` header value IS the
 * Clerk user id. This lets existing integration tests keep their
 * `.set("Authorization", `Bearer ${token}`)` calls unchanged — they simply pass
 * a Clerk user id instead of an HMAC token. Requests with no Bearer token are
 * treated as unauthenticated (userId === null).
 */

function getAuth(req) {
  const auth = (req && req.headers && req.headers["authorization"]) || "";
  const token =
    typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // If a Bearer token was provided, use it as the userId (even if empty, which
  // signals "no user"). Otherwise fall back to the per-file test default so
  // that functional integration tests pass without having to authenticate every
  // individual request — set process.env.TEST_DEFAULT_AUTH_USER in beforeAll.
  if (auth.startsWith("Bearer ")) {
    return { userId: token || null };
  }
  return { userId: process.env.TEST_DEFAULT_AUTH_USER || null };
}

const clerkClient = {
  users: {
    async getUser(userId) {
      return {
        id: userId,
        emailAddresses: [{ emailAddress: `${userId}@test.example` }],
      };
    },
  },
};

function clerkMiddleware() {
  return (_req, _res, next) => next();
}

module.exports = { getAuth, clerkClient, clerkMiddleware };
