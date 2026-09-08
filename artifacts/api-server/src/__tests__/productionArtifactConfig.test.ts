import fs from "node:fs";
import path from "node:path";

describe("API production artifact configuration", () => {
  it("starts the production runtime against the production database environment", () => {
    const artifactToml = fs.readFileSync(
      path.resolve(__dirname, "../../.replit-artifact/artifact.toml"),
      "utf8",
    );
    const productionRunEnv = artifactToml.match(
      /\[services\.production\.run\.env\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1];

    expect(productionRunEnv).toBeDefined();
    expect(productionRunEnv).toContain('NODE_ENV = "production"');
    expect(productionRunEnv).toContain('DATABASE_ENV = "production"');
  });
});