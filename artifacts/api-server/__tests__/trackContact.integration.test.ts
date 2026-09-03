/**
 * Integration tests for POST /api/track/screen-view and the /api/contact routes.
 *
 * Exercises the real database (screen_view_log, contact_messages) with
 * JEST-prefixed fixture values that are cleaned up afterwards.
 */

// ── Mock OpenAI BEFORE app is imported ────────────────────────────────────────
jest.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: jest.fn() } }, audio: { transcriptions: { create: jest.fn() } } },
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

// ── Imports ───────────────────────────────────────────────────────────────────
import { contactMessagesTable, db, screenViewLogTable, usersTable } from "@workspace/db";
import { eq, like } from "drizzle-orm";
import supertest from "supertest";

import app from "../src/app";
import { contactLimiter, screenViewLimiter } from "../src/lib/rateLimiter";
import { ADMIN_TEST_USER_ID } from "./helpers/adminAuth";

const NON_ADMIN_USER = "jest-trackcontact-user";
const SUBJECT_PREFIX = "JEST-CONTACT-";

/** Polls until `fn` returns a truthy value or the timeout elapses. */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  process.env.ADMIN_CLERK_USER_ID = ADMIN_TEST_USER_ID;
  process.env.TEST_DEFAULT_AUTH_USER = ADMIN_TEST_USER_ID;
  await db
    .insert(usersTable)
    .values({ clerkUserId: NON_ADMIN_USER, email: "tc@test.example", status: "approved", role: "user" })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { status: "approved", role: "user" },
    });
});

afterAll(async () => {
  delete process.env.TEST_DEFAULT_AUTH_USER;
  delete process.env.ADMIN_CLERK_USER_ID;
  await db.delete(usersTable).where(like(usersTable.clerkUserId, "jest-trackcontact-%"));
  await db.delete(contactMessagesTable).where(like(contactMessagesTable.subject, `${SUBJECT_PREFIX}%`));
  await db.delete(screenViewLogTable).where(like(screenViewLogTable.screenName, "JEST-SCREEN-%"));
}, 15_000);

beforeEach(async () => {
  await screenViewLimiter.reset();
  await contactLimiter.reset();
});

afterEach(() => {
  // clearAllMocks resets call history on jest.fn() instances (restoreAllMocks
  // only reverts jest.spyOn() spies, leaving jest.fn() call counts intact).
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/track/screen-view
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/track/screen-view", () => {
  it("returns 204 and logs a valid screen view with a rotating keyed visitor id", async () => {
    const startedAt = new Date();

    await supertest(app)
      .post("/api/track/screen-view")
      .send({ version: 1, event: "screen_view", screen: "Search" })
      .expect(204);

    // Insert is fire-and-forget via setImmediate — poll until visible
    const rows = await waitFor(async () => {
      const found = await db
        .select()
        .from(screenViewLogTable)
        .where(eq(screenViewLogTable.screenName, "Search"));
      return found.filter((row) => row.createdAt >= startedAt).slice(-1);
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.visitorHash).toMatch(/^[0-9a-f]{64}$/);
    // Raw IP must never be stored
    expect(rows[0]!.visitorHash).not.toContain(".");
  });

  it("rejects missing, unknown, oversized, and client-identified events", async () => {
    await supertest(app).post("/api/track/screen-view").send({}).expect(400);
    await supertest(app)
      .post("/api/track/screen-view")
      .send({ version: 1, event: "screen_view", screen: "Unknown Screen" })
      .expect(400);
    await supertest(app)
      .post("/api/track/screen-view")
      .send({ version: 1, event: "screen_view", screen: "Search", visitorId: "client-id" })
      .expect(400);
    await supertest(app)
      .post("/api/track/screen-view")
      .send({ version: 2, event: "screen_view", screen: "Search" })
      .expect(400);
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    jest
      .spyOn(screenViewLimiter, "check")
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 9000 });

    const res = await supertest(app)
      .post("/api/track/screen-view")
      .send({ screen: "JEST-SCREEN-limited" })
      .expect(429);

    expect(res.body.error).toMatch(/too many/i);
    expect(res.body.retryAfterMs).toBe(9000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/contact
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/contact", () => {
  it("creates a message and returns 201 with its id", async () => {
    const subject = `${SUBJECT_PREFIX}submit-${Date.now()}`;

    const res = await supertest(app)
      .post("/api/contact")
      .send({ subject, body: "Test message body", senderToken: "jest-sender" })
      .expect(201);

    expect(typeof res.body.id).toBe("number");

    const [row] = await db
      .select()
      .from(contactMessagesTable)
      .where(eq(contactMessagesTable.id, res.body.id));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(subject);
    expect(row!.body).toBe("Test message body");
    expect(row!.senderToken).toBe("jest-sender");
    expect(row!.readAt).toBeNull();
  });

  it("defaults senderToken to 'anonymous' when omitted", async () => {
    const subject = `${SUBJECT_PREFIX}anon-${Date.now()}`;

    const res = await supertest(app)
      .post("/api/contact")
      .send({ subject, body: "Anon body" })
      .expect(201);

    const [row] = await db
      .select()
      .from(contactMessagesTable)
      .where(eq(contactMessagesTable.id, res.body.id));
    expect(row!.senderToken).toBe("anonymous");
  });

  it("returns 400 when subject is missing", async () => {
    const res = await supertest(app)
      .post("/api/contact")
      .send({ body: "no subject" })
      .expect(400);
    expect(res.body.error).toMatch(/subject/i);
  });

  it("returns 400 when body is missing", async () => {
    const res = await supertest(app)
      .post("/api/contact")
      .send({ subject: `${SUBJECT_PREFIX}nobody` })
      .expect(400);
    expect(res.body.error).toMatch(/body/i);
  });

  it("returns 429 when the rate limiter rejects the request", async () => {
    jest
      .spyOn(contactLimiter, "check")
      .mockResolvedValueOnce({ allowed: false, retryAfterMs: 7000 });

    const res = await supertest(app)
      .post("/api/contact")
      .send({ subject: `${SUBJECT_PREFIX}limited`, body: "x" })
      .expect(429);

    expect(res.body.retryAfterMs).toBe(7000);
  });
});

describe("GET /api/contact (admin only)", () => {
  it("returns 403 for an approved non-admin user", async () => {
    const res = await supertest(app)
      .get("/api/contact")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);
    expect(res.body).toHaveProperty("error");
  });

  it("returns all messages newest-first for an admin", async () => {
    const older = `${SUBJECT_PREFIX}older-${Date.now()}`;
    const newer = `${SUBJECT_PREFIX}newer-${Date.now()}`;
    const r1 = await supertest(app).post("/api/contact").send({ subject: older, body: "b1" }).expect(201);
    // Ensure distinct createdAt ordering
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await supertest(app).post("/api/contact").send({ subject: newer, body: "b2" }).expect(201);

    const res = await supertest(app)
      .get("/api/contact")
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((m: { id: number }) => m.id);
    expect(ids).toContain(r1.body.id);
    expect(ids).toContain(r2.body.id);
    // Newest first
    expect(ids.indexOf(r2.body.id)).toBeLessThan(ids.indexOf(r1.body.id));
  });
});

describe("PATCH /api/contact/:id/read (admin only)", () => {
  it("marks a message read and returns its id", async () => {
    const subject = `${SUBJECT_PREFIX}read-${Date.now()}`;
    const created = await supertest(app)
      .post("/api/contact")
      .send({ subject, body: "to be read" })
      .expect(201);

    const res = await supertest(app)
      .patch(`/api/contact/${created.body.id}/read`)
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(200);

    expect(res.body.id).toBe(created.body.id);

    const [row] = await db
      .select()
      .from(contactMessagesTable)
      .where(eq(contactMessagesTable.id, created.body.id));
    expect(row!.readAt).not.toBeNull();
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await supertest(app)
      .patch("/api/contact/not-a-number/read")
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 404 for a nonexistent message id", async () => {
    const res = await supertest(app)
      .patch("/api/contact/999999999/read")
      .set("Authorization", `Bearer ${ADMIN_TEST_USER_ID}`)
      .expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 403 for a non-admin user", async () => {
    await supertest(app)
      .patch("/api/contact/1/read")
      .set("Authorization", `Bearer ${NON_ADMIN_USER}`)
      .expect(403);
  });
});
