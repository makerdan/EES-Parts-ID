/**
 * Unit tests for hashQuestion (answerCache).
 *
 * Focus: the admin-awareness of the cache key. Admin and non-admin answers
 * must occupy disjoint key spaces so a cached admin answer (which may contain
 * admin-only app knowledge) can never be served to a non-admin, and vice versa.
 * Also verifies the pre-existing cold-start vs. history key-space separation is
 * preserved when the admin sentinel is added.
 *
 * The db import in answerCache is mocked so this suite needs no database.
 */

jest.mock("@workspace/db", () => ({
  db: {},
  referenceAnswerCacheTable: { questionHash: "questionHash" },
}));

process.env.LOG_LEVEL = "silent";

import { hashQuestion, normalizeQuestion } from "../src/lib/answerCache";

describe("hashQuestion admin-awareness", () => {
  const q = normalizeQuestion("How do I import a CSV?");

  it("produces a different hash for admin vs. non-admin (cold-start)", () => {
    const nonAdmin = hashQuestion(q, undefined, false);
    const admin = hashQuestion(q, undefined, true);
    expect(admin).not.toBe(nonAdmin);
  });

  it("defaults to the non-admin key space when isAdmin is omitted", () => {
    expect(hashQuestion(q)).toBe(hashQuestion(q, undefined, false));
  });

  it("is deterministic for the same inputs", () => {
    expect(hashQuestion(q, undefined, true)).toBe(hashQuestion(q, undefined, true));
    expect(hashQuestion(q, undefined, false)).toBe(hashQuestion(q, undefined, false));
  });

  it("keeps admin and non-admin history hashes disjoint", () => {
    const history = [{ q: "hi", a: "hello" }];
    const nonAdmin = hashQuestion(q, history, false);
    const admin = hashQuestion(q, history, true);
    expect(admin).not.toBe(nonAdmin);
  });

  it("keeps cold-start and history key spaces disjoint for both roles", () => {
    const history = [{ q: "hi", a: "hello" }];
    // non-admin cold-start vs non-admin history
    expect(hashQuestion(q, undefined, false)).not.toBe(hashQuestion(q, history, false));
    // admin cold-start vs admin history
    expect(hashQuestion(q, undefined, true)).not.toBe(hashQuestion(q, history, true));
    // admin cold-start must not collide with a non-admin history hash
    expect(hashQuestion(q, undefined, true)).not.toBe(hashQuestion(q, history, false));
  });
});
