/**
 * Tests for POST /api/admin/query SQL-injection hardening.
 *
 * Covers:
 * - Auth guard (401 without a valid token)
 * - DDL rejection: DROP TABLE returns 400 before touching the DB
 * - DML rejection: DELETE FROM returns 400 before touching the DB
 * - Comment-bypass rejection: leading block comment before DELETE returns 400
 * - Leading line-comment bypass rejected: -- comment then DELETE returns 400
 * - Valid SELECT is accepted (pool.connect stub verifies the rolled-back
 *   transaction path)
 */

// ── OpenAI constructor mock (loaded transitively by ai routes at module init) ─
const mockCompletionsCreate = jest.fn().mockResolvedValue({
  id: "chatcmpl-mock",
  choices: [{ message: { role: "assistant", content: "hi" } }],
});

class MockRateLimitError extends Error {}
class MockInternalServerError extends Error {}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
class MockAuthenticationError extends Error {}
class MockPermissionDeniedError extends Error {}

const mockOpenAIConstructor = jest
  .fn()
  .mockImplementation(() => ({
    chat: { completions: { create: mockCompletionsCreate } },
  }));

(mockOpenAIConstructor as unknown as Record<string, unknown>).RateLimitError =
  MockRateLimitError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).InternalServerError =
  MockInternalServerError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionError =
  MockAPIConnectionError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).APIConnectionTimeoutError =
  MockAPIConnectionTimeoutError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).AuthenticationError =
  MockAuthenticationError;
(mockOpenAIConstructor as unknown as Record<string, unknown>).PermissionDeniedError =
  MockPermissionDeniedError;

jest.mock("openai", () => mockOpenAIConstructor);

// ── Standard workspace mocks ──────────────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: jest.fn() } },
    audio: { transcriptions: { create: jest.fn() } },
  },
  generateImageBuffer: jest.fn(),
  editImages: jest.fn(),
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

jest.mock("@workspace/integrations-openai-ai-server/batch", () => ({
  batchProcess: jest.fn(),
  batchProcessWithSSE: jest.fn(),
  isRateLimitError: jest.fn(() => false),
}));

// ── DB pool mock ──────────────────────────────────────────────────────────────
// For queries that are blocked at the validation layer, pool.connect() is never
// reached. For valid SELECT tests we provide a minimal stub that simulates the
// BEGIN / SET LOCAL / query / ROLLBACK sequence.
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
  release: mockRelease,
});

jest.mock("@workspace/db", () => ({
  pool: { connect: mockConnect },
  db: {},
  inventoryTable: {},
  usersTable: {},
}));

// ── Auth middleware mock ───────────────────────────────────────────────────────
// adminQuery is a unit test for the route handler; real Clerk auth would need a
// live DB + drizzle chain that is not set up in this suite.  We replace
// requireAppAuth with a lightweight shim that mirrors the real behaviour:
//   - no Bearer header → 401
//   - bootstrap admin token (ADMIN_CLERK_USER_ID) → sets appUser role="admin"
//   - any other token → 403 pending
jest.mock("../middlewares/requireAppAuth", () => ({
  requireAppAuth: (req: any, res: any, next: any): void => {
    const auth: string = (req.headers.authorization as string) ?? "";
    if (!auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = auth.slice(7);
    if (!token) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const adminId = process.env.ADMIN_CLERK_USER_ID ?? "";
    if (adminId && token === adminId) {
      res.locals.appUser = { clerkUserId: token, role: "admin", status: "approved" };
      next();
      return;
    }
    res.status(403).json({ error: "Account awaiting approval", code: "pending" });
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../app";
import { signAdminToken } from "../../__tests__/helpers/adminAuth";

// ── Helpers ───────────────────────────────────────────────────────────────────
const ADMIN_SECRET = "jest-adminquery-secret";

function makeAdminToken(): string {
  return signAdminToken(Date.now(), ADMIN_SECRET);
}

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("POST /api/admin/query — auth guard", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .send({ sql: "SELECT 1" })
      .expect(401);

    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 when an invalid (unknown) token is provided", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ sql: "SELECT 1" })
      .expect(403);

    expect(res.body).toHaveProperty("error");
  });
});

// ── SQL injection hardening — DDL / DML rejection ────────────────────────────

describe("POST /api/admin/query — DDL/DML rejection (SQL injection hardening)", () => {
  let token: string;

  beforeAll(() => {
    token = makeAdminToken();
  });

  beforeEach(() => {
    mockConnect.mockClear();
    mockQuery.mockClear();
    mockRelease.mockClear();
  });

  it("rejects DROP TABLE with 400 and never contacts the database", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "DROP TABLE inventory" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects DELETE FROM with 400 and never contacts the database", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "DELETE FROM inventory" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects a block-comment-prefixed DELETE with 400 (comment-bypass attempt)", async () => {
    // Attacker strips the leading keyword check by hiding behind a block comment.
    // stripLeadingComments() removes /* */ before validation, exposing DELETE.
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "/* */ DELETE FROM inventory" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects a line-comment-prefixed DELETE with 400 (comment-bypass attempt)", async () => {
    // Variant using a SQL line comment before DELETE.
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "-- comment\nDELETE FROM inventory" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects INSERT with 400", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "INSERT INTO inventory (catalog) VALUES ('x')" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects TRUNCATE with 400", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "TRUNCATE TABLE inventory" })
      .expect(400);

    expect(res.body).toHaveProperty("error");
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ── Rolled-back transaction path for valid SELECT queries ─────────────────────

describe("POST /api/admin/query — valid SELECT uses rolled-back transaction", () => {
  let token: string;

  beforeAll(() => {
    token = makeAdminToken();
  });

  beforeEach(() => {
    mockConnect.mockClear();
    mockQuery.mockClear();
    mockRelease.mockClear();

    // Stub the four sequential query calls inside the route handler:
    //   1. BEGIN
    //   2. SET LOCAL statement_timeout = ...
    //   3. The wrapped SELECT
    //   4. ROLLBACK
    mockQuery
      .mockResolvedValueOnce({})                                     // BEGIN
      .mockResolvedValueOnce({})                                     // SET LOCAL
      .mockResolvedValueOnce({ fields: [{ name: "id" }], rows: [{ id: 1 }] }) // SELECT
      .mockResolvedValueOnce({});                                    // ROLLBACK
  });

  it("calls ROLLBACK (not COMMIT) after a successful query", async () => {
    await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id FROM inventory LIMIT 1" })
      .expect(200);

    const calls: string[] = mockQuery.mock.calls.map(
      (c: [string, ...unknown[]]) => (c[0] as string).trim().toUpperCase(),
    );

    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    expect(calls.every((s) => s !== "COMMIT")).toBe(true);
  });

  it("returns column names and rows from the rolled-back query result", async () => {
    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id FROM inventory LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id"]);
    expect(res.body.rows).toEqual([{ id: 1 }]);
    expect(res.body.truncated).toBe(false);
  });

  it("releases the pool client even after a successful query", async () => {
    await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id FROM inventory LIMIT 1" })
      .expect(200);

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
