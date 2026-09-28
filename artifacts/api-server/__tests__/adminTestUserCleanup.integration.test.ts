import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  adminTestUserIdForWorker,
  cleanupJestAdminUsers,
  createJestInvocationId,
  JEST_ADMIN_TEST_EMAIL_SUFFIX,
} from "../src/lib/adminTestUserCleanup";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const OLD = new Date("2026-09-23T08:00:00.000Z");
const RECENT = new Date("2026-09-23T11:59:00.000Z");
const invocationA = createJestInvocationId("cleanup-a", 1811, NOW.getTime());
const invocationB = createJestInvocationId("cleanup-b", 1812, NOW.getTime());
const invocationC = createJestInvocationId("cleanup-c", 1813, NOW.getTime());
const ownedId = adminTestUserIdForWorker("1", invocationA);
const concurrentId = adminTestUserIdForWorker("2", invocationB);
const staleId = adminTestUserIdForWorker("3", invocationC);
const configuredId = "jest-admin-user-9000-1";
const legacyId = "jest-admin-user";
const malformedId = "jest-admin-user-not-a-run";
const mismatchedEmailId = "jest-admin-user-9010-1";
const unrelatedId = "jest-reference-admin-9011-1";
const seededIds = [
  ownedId,
  concurrentId,
  staleId,
  configuredId,
  legacyId,
  malformedId,
  mismatchedEmailId,
  unrelatedId,
];

function testEmail(clerkUserId: string): string {
  return `${clerkUserId}${JEST_ADMIN_TEST_EMAIL_SUFFIX}`;
}

async function seedRows(): Promise<void> {
  await db
    .delete(usersTable)
    .where(eq(usersTable.clerkUserId, ownedId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, concurrentId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, staleId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, configuredId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, legacyId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, malformedId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, mismatchedEmailId));
  await db.delete(usersTable).where(eq(usersTable.clerkUserId, unrelatedId));

  await db.insert(usersTable).values([
    {
      clerkUserId: ownedId,
      email: testEmail(ownedId),
      status: "approved",
      role: "admin",
      createdAt: RECENT,
      updatedAt: RECENT,
    },
    {
      clerkUserId: concurrentId,
      email: testEmail(concurrentId),
      status: "approved",
      role: "admin",
      createdAt: RECENT,
      updatedAt: RECENT,
    },
    {
      clerkUserId: staleId,
      email: testEmail(staleId),
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
    {
      clerkUserId: configuredId,
      email: testEmail(configuredId),
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
    {
      clerkUserId: legacyId,
      email: testEmail(legacyId),
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
    {
      clerkUserId: malformedId,
      email: testEmail(malformedId),
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
    {
      clerkUserId: mismatchedEmailId,
      email: "real.person@example.com",
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
    {
      clerkUserId: unrelatedId,
      email: testEmail(unrelatedId),
      status: "approved",
      role: "admin",
      createdAt: OLD,
      updatedAt: OLD,
    },
  ]);
}

beforeEach(async () => {
  await seedRows();
});

afterAll(async () => {
  for (const clerkUserId of seededIds) {
    await db.delete(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
  }
});

describe("Jest admin cleanup", () => {
  it("supports the explicit all-safe purge while preserving protected lookalikes", async () => {
    const report = await cleanupJestAdminUsers({
      mode: "all",
      configuredBootstrapAdminId: configuredId,
      apply: true,
      now: NOW,
    });

    expect(report.wouldDelete).toBeGreaterThanOrEqual(4);
    expect(report.deleted).toBe(report.wouldDelete);

    const protectedRows = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, malformedId));
    expect(protectedRows).toEqual([{ clerkUserId: malformedId }]);
  });

  it("deletes only the exact current invocation and is idempotent", async () => {
    const preview = await cleanupJestAdminUsers({
      mode: "exact",
      invocationId: invocationA,
      configuredBootstrapAdminId: configuredId,
      now: NOW,
    });

    expect(preview.apply).toBe(false);
    expect(preview.wouldDelete).toBe(1);
    expect(preview.deleted).toBe(0);
    expect(preview.protected).toBe(preview.before - 1);

    const applied = await cleanupJestAdminUsers({
      mode: "exact",
      invocationId: invocationA,
      configuredBootstrapAdminId: configuredId,
      apply: true,
      now: NOW,
    });
    expect(applied.deleted).toBe(1);
    expect(applied.remaining).toBe(applied.before - applied.deleted);

    const rerun = await cleanupJestAdminUsers({
      mode: "exact",
      invocationId: invocationA,
      configuredBootstrapAdminId: configuredId,
      apply: true,
      now: NOW,
    });
    expect(rerun.deleted).toBe(0);
    expect(rerun.remaining).toBe(applied.remaining);

    const concurrent = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, concurrentId));
    expect(concurrent).toEqual([{ clerkUserId: concurrentId }]);
  });

  it("recovers stale rows without deleting active, configured, malformed, or unrelated users", async () => {
    const report = await cleanupJestAdminUsers({
      mode: "stale",
      configuredBootstrapAdminId: configuredId,
      apply: true,
      now: NOW,
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(report.wouldDelete).toBeGreaterThanOrEqual(2);
    expect(report.deleted).toBe(report.wouldDelete);
    expect(report.remaining).toBe(report.before - report.deleted);

    const protectedRows = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, concurrentId));
    expect(protectedRows).toEqual([{ clerkUserId: concurrentId }]);

    const configuredRows = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, configuredId));
    expect(configuredRows).toEqual([{ clerkUserId: configuredId }]);

    const staleRows = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, staleId));
    const legacyRows = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, legacyId));
    expect(staleRows).toEqual([]);
    expect(legacyRows).toEqual([]);
  });
});