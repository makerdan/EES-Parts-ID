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

// ── Sensitive column masking ───────────────────────────────────────────────────

describe("POST /api/admin/query — sensitive column masking", () => {
  let token: string;

  beforeAll(() => {
    token = makeAdminToken();
  });

  beforeEach(() => {
    mockConnect.mockClear();
    mockQuery.mockClear();
    mockRelease.mockClear();
  });

  function stubQueryWithColumns(fields: Array<{ name: string }>, row: Record<string, unknown>) {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ fields, rows: [row] })
      .mockResolvedValueOnce({});
  }

  it("strips 'email' from response columns and rows", async () => {
    stubQueryWithColumns(
      [{ name: "id" }, { name: "email" }, { name: "name" }],
      { id: 1, email: "test@example.com", name: "Alice" },
    );

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, email, name FROM users LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id", "name"]);
    expect(res.body.rows[0]).not.toHaveProperty("email");
    expect(res.body.strippedColumns).toContain("email");
  });

  it("strips 'clerk_user_id' from response columns and rows", async () => {
    stubQueryWithColumns(
      [{ name: "id" }, { name: "clerk_user_id" }],
      { id: 1, clerk_user_id: "user_abc123" },
    );

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, clerk_user_id FROM users LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id"]);
    expect(res.body.rows[0]).not.toHaveProperty("clerk_user_id");
    expect(res.body.strippedColumns).toContain("clerk_user_id");
  });

  it("strips columns containing 'phone' (e.g. phone, phone_number, backup_phone)", async () => {
    stubQueryWithColumns(
      [{ name: "id" }, { name: "phone" }, { name: "phone_number" }, { name: "backup_phone" }, { name: "label" }],
      { id: 1, phone: "+15550001111", phone_number: "+15550002222", backup_phone: "+15550003333", label: "Alice" },
    );

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, phone, phone_number, backup_phone, label FROM users LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id", "label"]);
    expect(res.body.rows[0]).not.toHaveProperty("phone");
    expect(res.body.rows[0]).not.toHaveProperty("phone_number");
    expect(res.body.rows[0]).not.toHaveProperty("backup_phone");
    expect(res.body.strippedColumns).toContain("phone");
    expect(res.body.strippedColumns).toContain("phone_number");
    expect(res.body.strippedColumns).toContain("backup_phone");
  });

  it("strips columns containing 'user_id' (e.g. created_by_user_id, owner_user_id)", async () => {
    stubQueryWithColumns(
      [{ name: "id" }, { name: "created_by_user_id" }, { name: "owner_user_id" }, { name: "label" }],
      { id: 1, created_by_user_id: "user_x", owner_user_id: "user_y", label: "shelf" },
    );

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, created_by_user_id, owner_user_id, label FROM zones LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id", "label"]);
    expect(res.body.rows[0]).not.toHaveProperty("created_by_user_id");
    expect(res.body.rows[0]).not.toHaveProperty("owner_user_id");
    expect(res.body.strippedColumns).toContain("created_by_user_id");
    expect(res.body.strippedColumns).toContain("owner_user_id");
  });

  it("preserves non-sensitive columns and returns them intact", async () => {
    stubQueryWithColumns(
      [{ name: "id" }, { name: "catalog_number" }, { name: "aisle_id" }],
      { id: 42, catalog_number: "PN-001", aisle_id: 7 },
    );

    const res = await supertest(app)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, catalog_number, aisle_id FROM inventory LIMIT 1" })
      .expect(200);

    expect(res.body.columns).toEqual(["id", "catalog_number", "aisle_id"]);
    expect(res.body.rows[0]).toEqual({ id: 42, catalog_number: "PN-001", aisle_id: 7 });
    expect(res.body.strippedColumns).toEqual([]);
  });
});

// ── ADMIN_QUERY_SENSITIVE_COLUMNS override / fallback ──────────────────────────
// The sensitive-column denylist is compiled once at module load into
// SENSITIVE_COLUMN_PATTERN via buildSensitiveColumnPattern().  A bad override
// (invalid regex, or one that accidentally matches nothing) must NOT silently
// disable PII masking.  Because the pattern is evaluated at import time, each
// case here sets the env var, resets the module registry, and re-imports a
// fresh Express app so the pattern is (re)built from the current env value.

describe("POST /api/admin/query — ADMIN_QUERY_SENSITIVE_COLUMNS override/fallback", () => {
  const token = makeAdminToken();
  const originalEnv = process.env.ADMIN_QUERY_SENSITIVE_COLUMNS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ADMIN_QUERY_SENSITIVE_COLUMNS;
    } else {
      process.env.ADMIN_QUERY_SENSITIVE_COLUMNS = originalEnv;
    }
    jest.resetModules();
  });

  /**
   * Set the env override, reset the module registry, and re-import a fresh app
   * so its module-level SENSITIVE_COLUMN_PATTERN is rebuilt from `envValue`.
   */
  function loadFreshApp(envValue: string | undefined): typeof app {
    jest.resetModules();
    if (envValue === undefined) {
      delete process.env.ADMIN_QUERY_SENSITIVE_COLUMNS;
    } else {
      process.env.ADMIN_QUERY_SENSITIVE_COLUMNS = envValue;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../app").default as typeof app;
  }

  function stubQueryWithColumns(fields: Array<{ name: string }>, row: Record<string, unknown>) {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ fields, rows: [row] })
      .mockResolvedValueOnce({});
  }

  it("rebuilds the pattern from a valid custom override and strips the custom columns", async () => {
    // Custom denylist that has nothing to do with the defaults: any column named
    // "secret_field" or ending in "_private".  If the module rebuilt the pattern
    // from the env var, these are stripped while the default-only "email" column
    // (not in the custom pattern) is now returned verbatim.
    const freshApp = loadFreshApp("secret_field|.*_private");
    mockConnect.mockClear();
    mockQuery.mockClear();
    mockRelease.mockClear();

    stubQueryWithColumns(
      [{ name: "id" }, { name: "secret_field" }, { name: "notes_private" }, { name: "email" }],
      { id: 1, secret_field: "xyz", notes_private: "hush", email: "test@example.com" },
    );

    const res = await supertest(freshApp)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({ sql: "SELECT id, secret_field, notes_private, email FROM users LIMIT 1" })
      .expect(200);

    // Custom columns stripped …
    expect(res.body.strippedColumns).toContain("secret_field");
    expect(res.body.strippedColumns).toContain("notes_private");
    expect(res.body.rows[0]).not.toHaveProperty("secret_field");
    expect(res.body.rows[0]).not.toHaveProperty("notes_private");
    // … and the pattern truly replaced the default (email no longer matches).
    expect(res.body.columns).toContain("email");
    expect(res.body.rows[0].email).toBe("test@example.com");
    expect(res.body.strippedColumns).not.toContain("email");
  });

  it("falls back to the default denylist when the override is an invalid regex", async () => {
    // An unbalanced group makes `new RegExp` throw; buildSensitiveColumnPattern
    // must catch it and fall back to the default denylist rather than leaking.
    const freshApp = loadFreshApp("(unterminated[");
    mockConnect.mockClear();
    mockQuery.mockClear();
    mockRelease.mockClear();

    stubQueryWithColumns(
      [
        { name: "id" },
        { name: "email" },
        { name: "clerk_user_id" },
        { name: "phone" },
        { name: "created_by_user_id" },
        { name: "label" },
      ],
      {
        id: 1,
        email: "test@example.com",
        clerk_user_id: "user_abc",
        phone: "+15550001111",
        created_by_user_id: "user_x",
        label: "Alice",
      },
    );

    const res = await supertest(freshApp)
      .post("/api/admin/query")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sql: "SELECT id, email, clerk_user_id, phone, created_by_user_id, label FROM users LIMIT 1",
      })
      .expect(200);

    // Default PII denylist is still enforced despite the bad override.
    expect(res.body.strippedColumns).toEqual(
      expect.arrayContaining(["email", "clerk_user_id", "phone", "created_by_user_id"]),
    );
    expect(res.body.rows[0]).not.toHaveProperty("email");
    expect(res.body.rows[0]).not.toHaveProperty("clerk_user_id");
    expect(res.body.rows[0]).not.toHaveProperty("phone");
    expect(res.body.rows[0]).not.toHaveProperty("created_by_user_id");
    // Non-sensitive columns still returned.
    expect(res.body.columns).toContain("label");
    expect(res.body.rows[0].label).toBe("Alice");
  });
});
