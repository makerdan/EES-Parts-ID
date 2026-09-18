import fs from "node:fs";
import path from "node:path";

describe("API production artifact configuration", () => {
  it("builds and starts against the production database environment", () => {
    const artifactToml = fs.readFileSync(
      path.resolve(__dirname, "../../.replit-artifact/artifact.toml"),
      "utf8",
    );
    const productionBuildEnv = artifactToml.match(
      /\[services\.production\.build\.env\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1];
    const productionRunEnv = artifactToml.match(
      /\[services\.production\.run\.env\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1];

    expect(productionBuildEnv).toBeDefined();
    expect(productionBuildEnv).toContain('NODE_ENV = "production"');
    expect(productionBuildEnv).toContain('DATABASE_ENV = "production"');
    expect(productionRunEnv).toBeDefined();
    expect(productionRunEnv).toContain('NODE_ENV = "production"');
    expect(productionRunEnv).toContain('DATABASE_ENV = "production"');
  });
});