/**
 * End-to-end-style regression coverage for the admin preferences workflow.
 *
 * The test uses the real Express routes, Clerk-auth middleware, and PostgreSQL
 * persistence. The singleton preference row is snapshotted and restored so the
 * deterministic fixture cannot leak into other test runs.
 */

// ── Mock ESM-only dependencies before app is imported ────────────────────────
jest.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: jest.fn().mockReturnValue(
    (_req: unknown, _res: unknown, next: () => void) => next(),
  ),
}));

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

// ── Imports ───────────────────────────────────────────────────────────────────
import supertest from "supertest";
import app from "../src/app";
import { ADMIN_TEST_USER_ID, signAdminToken } from "./helpers/adminAuth";
import { adminPreferencesTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";

const ADMIN_TOKEN = signAdminToken();

const SAVED_PROFILE = {
  dimensionUnit: "in",
  textSize: "large",
  themeMode: "dark",
  defaultConfidenceThreshold: 85,
  scanSound: false,
} as const;

const ORIGINAL_SHELF_PREFERENCES = {
  shelfPrefix: "ORIG",
  shelfStep: 7,
} as const;

type PreferenceRow = typeof adminPreferencesTable.$inferSelect;
let originalPreference: PreferenceRow | undefined;

beforeAll(async () => {
  const rows = await db
    .select()
    .from(adminPreferencesTable)
    .where(eq(adminPreferencesTable.id, 1))
    .limit(1);
  originalPreference = rows[0];

  // Make the initial GET assertions deterministic and leave shelf state
  // unset until the shelf workflow explicitly saves it.
  await db
    .delete(adminPreferencesTable)
    .where(eq(adminPreferencesTable.id, 1));
});

afterAll(async () => {
  if (!originalPreference) {
    await db
      .delete(adminPreferencesTable)
      .where(eq(adminPreferencesTable.id, 1));
    return;
  }

  await db
    .insert(adminPreferencesTable)
    .values(originalPreference)
    .onConflictDoUpdate({
      target: adminPreferencesTable.id,
      set: {
        dimensionUnit: originalPreference.dimensionUnit,
        textSize: originalPreference.textSize,
        themeMode: originalPreference.themeMode,
        defaultConfidenceThreshold: originalPreference.defaultConfidenceThreshold,
        scanSound: originalPreference.scanSound,
        shelfPrefix: originalPreference.shelfPrefix,
        shelfStep: originalPreference.shelfStep,
        aiProvider: originalPreference.aiProvider,
        zoneAlignX: originalPreference.zoneAlignX,
        zoneAlignY: originalPreference.zoneAlignY,
        zoneAlignScale: originalPreference.zoneAlignScale,
        revokedBefore: originalPreference.revokedBefore,
        updatedAt: originalPreference.updatedAt,
      },
    });
});

describe("admin preferences round trip", () => {
  it("loads defaults, persists profile and shelf settings, and rejects unsafe writes", async () => {
    const initialProfile = await supertest(app)
      .get("/api/admin/profile")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(initialProfile.body).toEqual({
      dimensionUnit: "mm",
      textSize: "normal",
      themeMode: "system",
      defaultConfidenceThreshold: 50,
      scanSound: true,
    });

    const initialShelf = await supertest(app)
      .get("/api/admin/shelf-preferences")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(initialShelf.body).toEqual({ shelfPrefix: null, shelfStep: null });

    const savedProfile = await supertest(app)
      .put("/api/admin/profile")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send(SAVED_PROFILE)
      .expect(200);
    expect(savedProfile.body).toEqual(SAVED_PROFILE);

    const savedBothShelfPreferences = await supertest(app)
      .patch("/api/admin/shelf-preferences")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send(ORIGINAL_SHELF_PREFERENCES)
      .expect(200);
    expect(savedBothShelfPreferences.body).toEqual(ORIGINAL_SHELF_PREFERENCES);

    const savedPrefixOnly = await supertest(app)
      .patch("/api/admin/shelf-preferences")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ shelfPrefix: "RACK" })
      .expect(200);
    expect(savedPrefixOnly.body).toEqual({
      shelfPrefix: "RACK",
      shelfStep: ORIGINAL_SHELF_PREFERENCES.shelfStep,
    });

    const invalidProfile = await supertest(app)
      .put("/api/admin/profile")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ ...SAVED_PROFILE, defaultConfidenceThreshold: 101 })
      .expect(400);
    expect(invalidProfile.body).toHaveProperty("error");

    const invalidShelfPreferences = await supertest(app)
      .patch("/api/admin/shelf-preferences")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ shelfStep: 0 })
      .expect(400);
    expect(invalidShelfPreferences.body).toHaveProperty("error");

    const missingProfileAuth = await supertest(app)
      .put("/api/admin/profile")
      .send(SAVED_PROFILE)
      .expect(401);
    expect(missingProfileAuth.body).toHaveProperty("error");

    const missingShelfAuth = await supertest(app)
      .patch("/api/admin/shelf-preferences")
      .send({ shelfPrefix: "UNAUTHORIZED" })
      .expect(401);
    expect(missingShelfAuth.body).toHaveProperty("error");

    const freshProfile = await supertest(app)
      .get("/api/admin/profile")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(freshProfile.body).toEqual(SAVED_PROFILE);

    const freshShelfPreferences = await supertest(app)
      .get("/api/admin/shelf-preferences")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .expect(200);
    expect(freshShelfPreferences.body).toEqual({
      shelfPrefix: "RACK",
      shelfStep: ORIGINAL_SHELF_PREFERENCES.shelfStep,
    });

    // The auth test must exercise the configured administrator identity rather
    // than relying on a default test session.
    expect(ADMIN_TOKEN).toBe(ADMIN_TEST_USER_ID);
  });
});