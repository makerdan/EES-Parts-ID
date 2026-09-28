import {
  db,
  usersTable,
} from "@workspace/db";
import { getDatabaseEnvironment } from "@workspace/db/runtime-data-boundary";
import { inArray, like } from "drizzle-orm";

const JEST_ADMIN_USER_PREFIX = "jest-admin-user";
export const JEST_ADMIN_TEST_EMAIL_SUFFIX = "@test.example";
const JEST_ADMIN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const LEGACY_ADMIN_USER_ID = /^jest-admin-user$/;
const LEGACY_WORKER_ADMIN_USER_ID =
  /^jest-admin-user-[0-9]+-(?:[0-9]+|single)$/;
const CURRENT_ADMIN_USER_ID =
  /^jest-admin-user-([a-z0-9]+-[0-9]+-[a-z0-9]+)-worker-(?:[0-9]+|single)$/;
const INVOCATION_ID = /^[a-z0-9]+-[0-9]+-[a-z0-9]+$/;

type AdminUserCandidate = {
  clerkUserId: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
};

export type JestAdminCleanupMode = "all" | "exact" | "stale";

export type JestAdminCleanupOptions = {
  mode: JestAdminCleanupMode;
  apply?: boolean;
  invocationId?: string;
  configuredBootstrapAdminId?: string;
  now?: Date;
  staleAfterMs?: number;
};

export type JestAdminCleanupReport = {
  databaseEnvironment: "development" | "test";
  mode: JestAdminCleanupMode;
  apply: boolean;
  before: number;
  safeBefore: number;
  eligible: number;
  wouldDelete: number;
  deleted: number;
  protected: number;
  remaining: number;
};

export function createJestInvocationId(
  randomPart: string,
  pid: number,
  now = Date.now(),
): string {
  const normalizedRandomPart = randomPart.toLowerCase().replace(/[^a-z0-9]/g, "");
  const value = `j${now.toString(36)}-${pid}-${normalizedRandomPart.slice(0, 12)}`;
  if (!INVOCATION_ID.test(value)) {
    throw new Error("Generated Jest invocation id does not satisfy its safety contract.");
  }
  return value;
}

function getJestInvocationId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = env.JEST_INVOCATION_ID;
  if (candidate && INVOCATION_ID.test(candidate)) return candidate;
  return createJestInvocationId("fallback", process.pid);
}

export function adminTestUserIdForWorker(
  workerId = process.env.JEST_WORKER_ID ?? "single",
  invocationId = getJestInvocationId(),
): string {
  if (!/^(?:[0-9]+|single)$/.test(workerId)) {
    throw new Error("Jest worker id does not satisfy its safety contract.");
  }
  if (!INVOCATION_ID.test(invocationId)) {
    throw new Error("Jest invocation id does not satisfy its safety contract.");
  }
  return `${JEST_ADMIN_USER_PREFIX}-${invocationId}-worker-${workerId}`;
}

function isStrictJestAdminUserId(clerkUserId: string): boolean {
  return (
    LEGACY_ADMIN_USER_ID.test(clerkUserId) ||
    LEGACY_WORKER_ADMIN_USER_ID.test(clerkUserId) ||
    CURRENT_ADMIN_USER_ID.test(clerkUserId)
  );
}

function isSafeCandidate(
  row: AdminUserCandidate,
  configuredBootstrapAdminId: string | undefined,
): boolean {
  return (
    row.clerkUserId !== configuredBootstrapAdminId &&
    isStrictJestAdminUserId(row.clerkUserId) &&
    row.email === `${row.clerkUserId}${JEST_ADMIN_TEST_EMAIL_SUFFIX}`
  );
}

function belongsToInvocation(
  clerkUserId: string,
  invocationId: string | undefined,
): boolean {
  if (!invocationId) return false;
  const match = CURRENT_ADMIN_USER_ID.exec(clerkUserId);
  return match?.[1] === invocationId;
}

function isEligible(
  row: AdminUserCandidate,
  options: JestAdminCleanupOptions,
  configuredBootstrapAdminId: string | undefined,
): boolean {
  if (!isSafeCandidate(row, configuredBootstrapAdminId)) return false;

  if (options.mode === "all") return true;

  if (options.mode === "exact") {
    return belongsToInvocation(row.clerkUserId, options.invocationId);
  }

  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? JEST_ADMIN_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("staleAfterMs must be a positive finite number.");
  }
  const cutoff = new Date(now.getTime() - staleAfterMs);
  return row.updatedAt < cutoff;
}

async function selectCandidates(): Promise<Array<AdminUserCandidate>> {
  return db
    .select({
      clerkUserId: usersTable.clerkUserId,
      email: usersTable.email,
      createdAt: usersTable.createdAt,
      updatedAt: usersTable.updatedAt,
    })
    .from(usersTable)
    .where(like(usersTable.clerkUserId, `${JEST_ADMIN_USER_PREFIX}%`));
}

/**
 * Delete only synthetic Jest bootstrap-admin rows that satisfy both the
 * identity and Clerk test-email contracts. `all` is reserved for the explicit
 * one-time purge; wrappers use `exact` and `stale`.
 */
export async function cleanupJestAdminUsers(
  options: JestAdminCleanupOptions,
): Promise<JestAdminCleanupReport> {
  const databaseEnvironment = getDatabaseEnvironment();
  if (databaseEnvironment === "production") {
    throw new Error(
      "Jest admin cleanup refuses DATABASE_ENV=production.",
    );
  }

  if (options.mode === "exact" && !options.invocationId) {
    throw new Error("Exact Jest admin cleanup requires an invocation id.");
  }

  const configuredBootstrapAdminId =
    options.configuredBootstrapAdminId ?? process.env.ADMIN_CLERK_USER_ID;
  const beforeRows = await selectCandidates();
  const safeRows = beforeRows.filter((row) =>
    isSafeCandidate(row, configuredBootstrapAdminId),
  );
  const eligibleRows = beforeRows.filter((row) =>
    isEligible(row, options, configuredBootstrapAdminId),
  );
  const eligibleIds = eligibleRows.map((row) => row.clerkUserId);

  let deleted = 0;
  if (options.apply && eligibleIds.length > 0) {
    const deletedRows = await db
      .delete(usersTable)
      .where(inArray(usersTable.clerkUserId, eligibleIds))
      .returning({ clerkUserId: usersTable.clerkUserId });
    deleted = deletedRows.length;
  }

  const remaining = (await selectCandidates()).length;
  return {
    databaseEnvironment,
    mode: options.mode,
    apply: Boolean(options.apply),
    before: beforeRows.length,
    safeBefore: safeRows.length,
    eligible: eligibleRows.length,
    wouldDelete: eligibleRows.length,
    deleted,
    protected: beforeRows.length - eligibleRows.length,
    remaining,
  };
}

export function formatJestAdminCleanupReport(
  report: JestAdminCleanupReport,
): string {
  return [
    `Jest admin cleanup (${report.databaseEnvironment}, ${report.mode}, ${report.apply ? "apply" : "dry-run"})`,
    `before=${report.before} safe=${report.safeBefore} wouldDelete=${report.wouldDelete} deleted=${report.deleted} protected=${report.protected} remaining=${report.remaining}`,
  ].join("\n");
}