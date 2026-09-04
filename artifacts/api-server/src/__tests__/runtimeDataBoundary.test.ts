import {
  assertDatabaseExecutionMode,
  getClientPublicEnvironment,
} from "@workspace/db/runtime-data-boundary";

import {
  formatMissingProductionEnvError,
  getEnvironmentContract,
  getMissingProductionEnvVars,
} from "../lib/validateEnv";

describe("runtime data boundary", () => {
  it("reports missing production names without including secret values", () => {
    const missing = getMissingProductionEnvVars({
      NODE_ENV: "production",
      AI_PROVIDER: "openai",
    });
    const error = formatMissingProductionEnvError(missing);

    expect(missing.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "DATABASE_ENV",
        "DATABASE_URL",
        "CLERK_PUBLISHABLE_KEY",
        "CLERK_SECRET_KEY",
        "CORS_ALLOWED_ORIGINS",
        "AI_INTEGRATIONS_OPENAI_BASE_URL",
        "AI_INTEGRATIONS_OPENAI_API_KEY",
      ]),
    );
    expect(error).toContain("DATABASE_URL");
    expect(error).not.toContain("postgresql://");
    expect(error).not.toContain("sk_live_");
    expect(error).not.toContain("openai-secret");
  });

  it("accepts a complete Replit production runtime contract", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_ENV: "production",
      DATABASE_URL: "test-database",
      CLERK_PUBLISHABLE_KEY: "test-public-key",
      CLERK_SECRET_KEY: "test-secret-key",
      CORS_ALLOWED_ORIGINS: "https://parts.example",
      AI_PROVIDER: "poe",
      POE_API_KEY2: "test-ai-key",
    };

    expect(getMissingProductionEnvVars(env)).toHaveLength(0);
    expect(assertDatabaseExecutionMode("application", env)).toBe("production");
  });

  it("returns only explicitly public client configuration", () => {
    const publicEnv = getClientPublicEnvironment({
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "test-public-key",
      EXPO_PUBLIC_API_BASE: "https://parts.example/api",
      DATABASE_URL: "test-database",
      CLERK_SECRET_KEY: "test-secret-key",
      POE_API_KEY2: "test-ai-key",
      DEFAULT_OBJECT_STORAGE_BUCKET_ID: "test-bucket",
    });

    expect(publicEnv).toEqual({
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "test-public-key",
      EXPO_PUBLIC_API_BASE: "https://parts.example/api",
    });
    expect(Object.keys(publicEnv)).not.toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "CLERK_SECRET_KEY",
        "POE_API_KEY2",
        "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
      ]),
    );
  });

  it("keeps server-only and public variables in separate contract lists", () => {
    const contract = getEnvironmentContract();
    expect(contract.serverOnly).toContain("DATABASE_URL");
    expect(contract.serverOnly).toContain("CLERK_SECRET_KEY");
    expect(contract.clientPublic).toContain("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(contract.clientPublic).not.toContain("DATABASE_URL");
    expect(contract.clientPublic).not.toContain("CLERK_SECRET_KEY");
  });

  it.each(["test", "seed", "schema-sync"] as const)(
    "rejects %s execution against production",
    (operation) => {
      expect(() =>
        assertDatabaseExecutionMode(operation, {
          DATABASE_ENV: "production",
          NODE_ENV: operation === "test" ? "test" : "development",
          JEST_WORKER_ID: operation === "test" ? "1" : undefined,
        }),
      ).toThrow(/cannot target DATABASE_ENV=production|requires DATABASE_ENV=test/);
    },
  );
});