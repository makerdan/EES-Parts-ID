/**
 * Regression probes for API test lifecycle isolation.
 *
 * These checks intentionally create decoys that look like another suite's
 * fixtures, then verify exact cleanup leaves those decoys untouched.
 */

import { db, floorPlanMetaTable, inventoryTable, pool, usersTable, warehouseZoneTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  cleanupEditableItem,
  cleanupFixtures,
  cleanupTestUser,
  editableCatalogForWorker,
  seedEditableItem,
  seedFixtures,
  seedTestUser,
  standardFixturesForWorker,
  workerQualifiedUserId,
} from "./helpers/testDb";
import { createOpenAIMock } from "./helpers/openaiMock";
import { setTestEnv } from "./helpers/testEnv";

const ownedUser = workerQualifiedUserId("jest-isolation-owned-user");
const decoyUser = workerQualifiedUserId("jest-isolation-owned-user", "other-process");
const ownedCatalog = `${workerQualifiedUserId("JEST-ISOLATION-OWNED")}-CATALOG`;
const decoyCatalog = `${workerQualifiedUserId("JEST-ISOLATION-OWNED", "other-process")}-CATALOG`;
const ownedAisle = workerQualifiedUserId("JEST-ISOLATION-OWNED-AISLE");
const decoyAisle = workerQualifiedUserId("JEST-ISOLATION-OWNED-AISLE", "other-process");
const ownedHash = `jest-isolation-owned-${process.pid}-${process.env.JEST_WORKER_ID ?? "single"}`;
const decoyHash = "jest-isolation-decoy";

beforeAll(async () => {
  await Promise.all([
    seedTestUser({ clerkUserId: ownedUser }),
    seedTestUser({ clerkUserId: decoyUser }),
    seedFixtures([{
      vendor: "JEST",
      catalog: ownedCatalog,
      description: "owned isolation fixture",
    }]),
    db.insert(inventoryTable).values({
      vendor: "JEST",
      catalog: decoyCatalog,
      description: "decoy isolation fixture",
      binLocations: [],
      aiKeywords: [],
    }).onConflictDoNothing(),
    db.insert(warehouseZoneTable).values({
      aisleId: ownedAisle,
      svgX: 0,
      svgY: 0,
      svgWidth: 1,
      svgHeight: 1,
    }).onConflictDoNothing(),
    db.insert(warehouseZoneTable).values({
      aisleId: decoyAisle,
      svgX: 0,
      svgY: 0,
      svgWidth: 1,
      svgHeight: 1,
    }).onConflictDoNothing(),
    db.insert(floorPlanMetaTable).values([
      { objectPath: `/objects/${ownedHash}.svg`, hash: ownedHash },
      { objectPath: `/objects/${decoyHash}.svg`, hash: decoyHash },
    ]).onConflictDoNothing(),
  ]);
});

afterAll(async () => {
  await Promise.all([
    cleanupTestUser(ownedUser),
    cleanupTestUser(decoyUser),
    db.delete(inventoryTable).where(eq(inventoryTable.catalog, decoyCatalog)),
    db.delete(warehouseZoneTable).where(
      eq(warehouseZoneTable.aisleId, decoyAisle),
    ),
    db.delete(floorPlanMetaTable).where(eq(floorPlanMetaTable.hash, decoyHash)),
  ]);
  await cleanupFixtures();
});

describe("API test lifecycle isolation", () => {
  it("cleans only the owned user and leaves a concurrent decoy", async () => {
    await cleanupTestUser(ownedUser);

    const remaining = await db
      .select({ clerkUserId: usersTable.clerkUserId })
      .from(usersTable)
      .where(eq(usersTable.clerkUserId, decoyUser));

    expect(remaining).toEqual([{ clerkUserId: decoyUser }]);
  });

  it("cleans only tracked inventory fixtures", async () => {
    await cleanupFixtures();

    const remaining = await db
      .select({ catalog: inventoryTable.catalog })
      .from(inventoryTable)
      .where(eq(inventoryTable.catalog, decoyCatalog));

    expect(remaining).toEqual([{ catalog: decoyCatalog }]);
  });

  it("keeps standard and editable fixtures distinct across invocations", async () => {
    const invocationA = "simulated-process-a";
    const invocationB = "simulated-process-b";
    const standardA = standardFixturesForWorker(invocationA);
    const standardB = standardFixturesForWorker(invocationB);

    expect(standardA.map(({ catalog }) => catalog)).not.toEqual(
      standardB.map(({ catalog }) => catalog),
    );

    await Promise.all([
      seedEditableItem(invocationA),
      seedEditableItem(invocationB),
    ]);
    await cleanupEditableItem(invocationA);

    const remaining = await db
      .select({ catalog: inventoryTable.catalog })
      .from(inventoryTable)
      .where(
        eq(
          inventoryTable.catalog,
          editableCatalogForWorker(invocationB),
        ),
      );

    expect(remaining).toEqual([
      { catalog: editableCatalogForWorker(invocationB) },
    ]);
    await cleanupEditableItem(invocationB);
  });

  it("does not end the shared pool during suite-owned cleanup", async () => {
    await db.delete(warehouseZoneTable).where(eq(warehouseZoneTable.aisleId, ownedAisle));
    await db.delete(floorPlanMetaTable).where(eq(floorPlanMetaTable.hash, ownedHash));

    expect((pool as unknown as { ended?: boolean }).ended).not.toBe(true);

    const decoyZone = await db
      .select({ aisleId: warehouseZoneTable.aisleId })
      .from(warehouseZoneTable)
      .where(eq(warehouseZoneTable.aisleId, decoyAisle));
    const decoyMeta = await db
      .select({ hash: floorPlanMetaTable.hash })
      .from(floorPlanMetaTable)
      .where(eq(floorPlanMetaTable.hash, decoyHash));

    expect(decoyZone).toEqual([{ aisleId: decoyAisle }]);
    expect(decoyMeta).toEqual([{ hash: decoyHash }]);
  });

  it("restores temporary authentication defaults", () => {
    const before = process.env.TEST_DEFAULT_AUTH_USER;
    const restore = setTestEnv({ TEST_DEFAULT_AUTH_USER: ownedUser });

    expect(process.env.TEST_DEFAULT_AUTH_USER).toBe(ownedUser);
    restore();

    expect(process.env.TEST_DEFAULT_AUTH_USER).toBe(before);
  });

  it("preserves OpenAI static error-class identity", () => {
    const MockOpenAI = createOpenAIMock(jest);
    const error = new (MockOpenAI as unknown as {
      RateLimitError: new () => Error;
    }).RateLimitError();

    expect(error).toBeInstanceOf(
      (MockOpenAI as unknown as { RateLimitError: new () => Error }).RateLimitError,
    );
  });
});