/**
 * Regression probes for API test lifecycle isolation.
 *
 * These checks intentionally create decoys that look like another suite's
 * fixtures, then verify exact cleanup leaves those decoys untouched.
 */

import {
  abbreviationMapTable,
  db,
  electricalSlangMapTable,
  floorPlanMetaTable,
  inventoryTable,
  misspellingMapTable,
  pool,
  synonymMapTable,
  usersTable,
  warehouseZoneTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  cleanupEditableItem,
  cleanupFixtures,
  cleanupDictionaryFixtures,
  cleanupTestUser,
  dictionaryFixturesForWorker,
  editableCatalogForWorker,
  seedDictionaryFixtures,
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

  it("restores a pre-existing user when helper setup replaces it", async () => {
    const userId = workerQualifiedUserId("jest-isolation-restored-user");
    const original = {
      clerkUserId: userId,
      email: `${userId}@original.example`,
      status: "banned" as const,
      role: "admin" as const,
    };

    await db.delete(usersTable).where(eq(usersTable.clerkUserId, userId));
    await db.insert(usersTable).values(original);
    try {
      await seedTestUser({ clerkUserId: userId, status: "approved", role: "user" });
      await cleanupTestUser(userId);

      const [restored] = await db
        .select({
          clerkUserId: usersTable.clerkUserId,
          email: usersTable.email,
          status: usersTable.status,
          role: usersTable.role,
        })
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, userId));
      expect(restored).toEqual(original);
    } finally {
      await db.delete(usersTable).where(eq(usersTable.clerkUserId, userId));
    }
  });

  it("does not claim an inventory row that seedFixtures found already present", async () => {
    const catalog = workerQualifiedUserId("jest-isolation-pre-existing-catalog");
    await db.delete(inventoryTable).where(eq(inventoryTable.catalog, catalog));
    await db.insert(inventoryTable).values({
      vendor: "JEST",
      catalog,
      description: "pre-existing inventory fixture",
      binLocations: [],
      aiKeywords: [],
    });
    try {
      const rows = await seedFixtures([{
        vendor: "JEST",
        catalog,
        description: "replacement should not be owned",
      }]);
      expect(rows).toEqual([]);
      await cleanupFixtures();

      const [remaining] = await db
        .select({
          vendor: inventoryTable.vendor,
          description: inventoryTable.description,
        })
        .from(inventoryTable)
        .where(eq(inventoryTable.catalog, catalog));
      expect(remaining).toEqual({
        vendor: "JEST",
        description: "pre-existing inventory fixture",
      });
    } finally {
      await db.delete(inventoryTable).where(eq(inventoryTable.catalog, catalog));
    }
  });

  it("cleans dictionary rows owned before setup fails mid-sequence", async () => {
    const workerInstance = workerQualifiedUserId("jest-isolation-dictionary-failure");
    const fixtures = dictionaryFixturesForWorker(workerInstance);
    const originalSlang = {
      slangTerm: fixtures.slang,
      standardTerms: ["pre-existing connector"],
      category: "pre-existing",
      notes: "must survive failed fixture setup",
    };

    await db.insert(electricalSlangMapTable).values(originalSlang);
    const actualInsert = db.insert.bind(db);
    const insertSpy = jest.spyOn(db, "insert").mockImplementation((table) => {
      if (table === electricalSlangMapTable) {
        throw new Error("injected dictionary setup failure");
      }
      return actualInsert(table);
    });

    try {
      await expect(seedDictionaryFixtures(workerInstance)).rejects.toThrow(
        "injected dictionary setup failure",
      );
      await cleanupDictionaryFixtures(workerInstance);

      const [abbreviation, synonym, misspelling, slang] = await Promise.all([
        db
          .select({ abbreviation: abbreviationMapTable.abbreviation })
          .from(abbreviationMapTable)
          .where(eq(abbreviationMapTable.abbreviation, fixtures.abbreviation)),
        db
          .select({ term: synonymMapTable.term })
          .from(synonymMapTable)
          .where(eq(synonymMapTable.term, fixtures.synonym)),
        db
          .select({ misspelling: misspellingMapTable.misspelling })
          .from(misspellingMapTable)
          .where(eq(misspellingMapTable.misspelling, fixtures.misspelling)),
        db
          .select({
            slangTerm: electricalSlangMapTable.slangTerm,
            standardTerms: electricalSlangMapTable.standardTerms,
            category: electricalSlangMapTable.category,
            notes: electricalSlangMapTable.notes,
          })
          .from(electricalSlangMapTable)
          .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang)),
      ]);

      expect(abbreviation).toEqual([]);
      expect(synonym).toEqual([]);
      expect(misspelling).toEqual([]);
      expect(slang).toEqual([originalSlang]);
    } finally {
      insertSpy.mockRestore();
      await cleanupDictionaryFixtures(workerInstance);
      await db
        .delete(electricalSlangMapTable)
        .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang));
    }
  });

  it("retries failed dictionary cleanup without masking the original failure", async () => {
    const workerInstance = workerQualifiedUserId("jest-isolation-dictionary-cleanup-retry");
    const fixtures = dictionaryFixturesForWorker(workerInstance);
    const originalSlang = {
      slangTerm: fixtures.slang,
      standardTerms: ["pre-existing connector"],
      category: "pre-existing",
      notes: "must survive cleanup retries",
    };
    const originalFailure = new Error("injected dictionary setup failure");
    const cleanupFailure = new Error("injected dictionary cleanup failure");
    const attemptedDeletes: unknown[] = [];

    await db.insert(electricalSlangMapTable).values(originalSlang);

    const actualInsert = db.insert.bind(db);
    const insertSpy = jest.spyOn(db, "insert").mockImplementation((table) => {
      if (table === electricalSlangMapTable) throw originalFailure;
      return actualInsert(table);
    });

    const actualDelete = db.delete.bind(db);
    const deleteSpy = jest.spyOn(db, "delete").mockImplementation((table) => {
      attemptedDeletes.push(table);
      if (table === misspellingMapTable) throw cleanupFailure;
      return actualDelete(table);
    });

    try {
      await expect((async () => {
        try {
          await seedDictionaryFixtures(workerInstance);
        } finally {
          await cleanupDictionaryFixtures(workerInstance);
        }
      })()).rejects.toBe(originalFailure);

      expect(attemptedDeletes).toEqual(expect.arrayContaining([
        abbreviationMapTable,
        synonymMapTable,
        misspellingMapTable,
      ]));
      expect(attemptedDeletes).not.toContain(electricalSlangMapTable);
      insertSpy.mockRestore();

      const [abbreviation, synonym, misspelling, slang] = await Promise.all([
        db
          .select({ abbreviation: abbreviationMapTable.abbreviation })
          .from(abbreviationMapTable)
          .where(eq(abbreviationMapTable.abbreviation, fixtures.abbreviation)),
        db
          .select({ term: synonymMapTable.term })
          .from(synonymMapTable)
          .where(eq(synonymMapTable.term, fixtures.synonym)),
        db
          .select({ misspelling: misspellingMapTable.misspelling })
          .from(misspellingMapTable)
          .where(eq(misspellingMapTable.misspelling, fixtures.misspelling)),
        db
          .select({
            slangTerm: electricalSlangMapTable.slangTerm,
            standardTerms: electricalSlangMapTable.standardTerms,
            category: electricalSlangMapTable.category,
            notes: electricalSlangMapTable.notes,
          })
          .from(electricalSlangMapTable)
          .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang)),
      ]);

      expect(abbreviation).toEqual([]);
      expect(synonym).toEqual([]);
      expect(misspelling).toEqual([{ misspelling: fixtures.misspelling }]);
      expect(slang).toEqual([originalSlang]);
    } finally {
      insertSpy.mockRestore();
      deleteSpy.mockRestore();
      await cleanupDictionaryFixtures(workerInstance);

      const [misspelling, slang] = await Promise.all([
        db
          .select({ misspelling: misspellingMapTable.misspelling })
          .from(misspellingMapTable)
          .where(eq(misspellingMapTable.misspelling, fixtures.misspelling)),
        db
          .select({
            slangTerm: electricalSlangMapTable.slangTerm,
            standardTerms: electricalSlangMapTable.standardTerms,
            category: electricalSlangMapTable.category,
            notes: electricalSlangMapTable.notes,
          })
          .from(electricalSlangMapTable)
          .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang)),
      ]);

      expect(misspelling).toEqual([]);
      expect(slang).toEqual([originalSlang]);

      await db
        .delete(electricalSlangMapTable)
        .where(eq(electricalSlangMapTable.slangTerm, fixtures.slang));
    }
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